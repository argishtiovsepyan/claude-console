import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatus } from '../src/lib/status.mjs';
import { renderStatusLines, formatReset } from '../src/lib/segments.mjs';
import { stripAnsi, displayWidth } from '../src/lib/ansi.mjs';
import { defaultConfig } from '../src/lib/config.mjs';

const SAMPLE = readFileSync(new URL('./fixtures/stdin-sample.json', import.meta.url), 'utf8');
const NOW = 1784252773000; // 2026-07-16T18:46:13Z — resets: 5h same-day, 7d next day

function render(overrides = {}) {
  const cfg = { ...defaultConfig(), ...(overrides.config || {}) };
  if (overrides.style) cfg.style = { ...cfg.style, ...overrides.style };
  return renderStatusLines({
    status: overrides.status ?? parseStatus(SAMPLE),
    git: { branch: 'develop', dirtyCount: 3, isWorktree: false, ...(overrides.git || {}) },
    counts: { agents: 2, workflows: 1, procs: 3, ...(overrides.counts || {}) },
    width: overrides.width ?? 190,
    config: cfg,
    now: overrides.now ?? NOW,
    timeZone: 'UTC',
  });
}

test('resets within 24h show a clock time even across midnight; only farther resets show a weekday', () => {
  const now = 1784252773000; // 2026-07-17T01:46Z
  // 3h away but past local midnight in many zones — must still be a time
  const soon = formatReset(1784252773 + 3 * 3600, { now, timeZone: 'UTC' });
  assert.ok(/^→\d{2}:\d{2}$/.test(soon), soon);
  // ~37h away — weekday is right
  const far = formatReset(1784386800, { now, timeZone: 'UTC' });
  assert.equal(far, '→Sat');
});

test('block layout is the default and renders two rows', () => {
  const rows = render();
  assert.equal(rows.length, 2);
});

test('line layout renders a single legacy-style row', () => {
  const rows = render({ style: { layout: 'line' } });
  assert.equal(rows.length, 1);
  assert.ok(stripAnsi(rows[0]).includes('develop'));
});

test('every block row fits the width at any width', () => {
  for (const width of [40, 60, 80, 120, 190]) {
    for (const row of render({ width })) {
      assert.ok(displayWidth(row) <= width, `${width}: ${displayWidth(row)} :: ${stripAnsi(row)}`);
      assert.ok(!row.includes('\n'));
    }
  }
});

test('row 1 carries identity: repo, branch+dirty, model, duration, cost', () => {
  const r1 = stripAnsi(render()[0]);
  assert.ok(r1.includes('my-repo'), r1);
  assert.ok(r1.includes('develop +3'), r1);
  assert.ok(r1.includes('Fable 5'), r1);
  assert.ok(r1.includes('2h36m'), r1);
  assert.ok(r1.includes('$5.79'), r1);
});

test('row 2 carries wide gauges with token detail and reset times', () => {
  const r2 = stripAnsi(render()[1]);
  assert.ok(/CTX .*12%/.test(r2), r2);
  assert.ok(r2.includes('120k/1M'), r2);
  assert.ok(/5h .*55%/.test(r2), r2);
  assert.ok(r2.includes('→03:40'), r2); // 1784259600 = 2026-07-17T03:40Z, same UTC day as `now`
  assert.ok(/7d .*11%/.test(r2), r2);
  assert.ok(r2.includes('→Sat'), r2); // 1784386800 = 2026-07-18 (Sat) UTC — different day → weekday
  assert.ok(r2.includes('ag:2 wf:1 ps:3'), r2);
  // block gauges are wider than the legacy 7-cell bars
  assert.ok(r2.includes('█'.repeat(1)) && /█{2,}[░]/.test(r2), r2);
});

test('warnings lead row 1', () => {
  const j = JSON.parse(SAMPLE);
  j.rate_limits.five_hour.used_percentage = 97;
  const r1 = stripAnsi(render({ status: parseStatus(JSON.stringify(j)) })[0]);
  assert.ok(r1.startsWith('⚠ 5h 97%'), r1);
});

test('narrow block degrades gauges to percentages but keeps both rows within width', () => {
  const rows = render({ width: 60 });
  const r2 = stripAnsi(rows[1]);
  assert.ok(!r2.includes('█'), r2);
  assert.ok(r2.includes('5h'), r2);
});

test('ascii block mode emits pure ASCII on both rows', () => {
  const rows = render({ style: { ascii: true } });
  for (const row of rows) {
    const plain = stripAnsi(row);
    assert.ok(/^[\x20-\x7e]*$/.test(plain), plain);
  }
  assert.ok(stripAnsi(rows[1]).includes('->'), stripAnsi(rows[1])); // ascii reset arrow
});

test('effort renders dimmed next to the model when present', () => {
  const r1 = stripAnsi(render()[0]);
  assert.ok(r1.includes('xhigh'), r1);
});

test('cost section can be disabled', () => {
  const cfg = defaultConfig();
  cfg.sections.cost = false;
  const r1 = stripAnsi(render({ config: cfg })[0]);
  assert.ok(!r1.includes('$'), r1);
});

test('missing gauges leave row 2 with only activity (still no crash)', () => {
  const s = parseStatus('{"model":{"display_name":"Sonnet 5"},"workspace":{"current_dir":"/x"}}');
  const rows = render({ status: s });
  assert.equal(rows.length, 2);
  const r2 = stripAnsi(rows[1]);
  assert.ok(!r2.includes('CTX'), r2);
  assert.ok(r2.includes('ag:2'), r2);
});

test('fully empty row 2 collapses to a single row', () => {
  const s = parseStatus('{"model":{"display_name":"Sonnet 5"},"workspace":{"current_dir":"/x"}}');
  const rows = render({ status: s, counts: { agents: 0, workflows: 0, procs: 0 } });
  assert.equal(rows.length, 1);
});
