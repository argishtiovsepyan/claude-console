import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatus } from '../src/lib/status.mjs';
import { renderLine } from '../src/lib/segments.mjs';
import { stripAnsi, displayWidth } from '../src/lib/ansi.mjs';
import { defaultConfig } from '../src/lib/config.mjs';

const SAMPLE = readFileSync(new URL('./fixtures/stdin-sample.json', import.meta.url), 'utf8');

function render(overrides = {}) {
  const status = overrides.status ?? parseStatus(SAMPLE);
  return renderLine({
    status,
    git: { branch: 'develop', dirtyCount: 0, isWorktree: false, ...(overrides.git || {}) },
    counts: { agents: 0, workflows: 0, procs: 0, ...(overrides.counts || {}) },
    width: overrides.width ?? 200,
    config: { ...defaultConfig(), ...(overrides.config || {}) },
    now: overrides.now ?? 1784252773000,
  });
}

// ---------- wide: parity-plus ----------

test('wide render keeps the legacy order: branch | model | CTX | 5h | 7d', () => {
  const plain = stripAnsi(render());
  const iBranch = plain.indexOf('develop');
  const iModel = plain.indexOf('Fable 5');
  const iCtx = plain.indexOf('CTX:');
  const i5h = plain.indexOf('5h:');
  const i7d = plain.indexOf('7d:');
  for (const [a, b] of [[iBranch, iModel], [iModel, iCtx], [iCtx, i5h], [i5h, i7d]]) {
    assert.ok(a >= 0 && b >= 0 && a < b, plain);
  }
});

test('bars match legacy widths and fill math (CTX width 10, usage width 7)', () => {
  const plain = stripAnsi(render());
  assert.ok(plain.includes('CTX: █░░░░░░░░░ 12%'), plain);
  assert.ok(plain.includes('5h: ████░░░ 55%'), plain);
  assert.ok(plain.includes('7d: █░░░░░░ 11%'), plain);
});

test('wide render includes session duration', () => {
  const plain = stripAnsi(render());
  assert.ok(plain.includes('2h36m'), plain); // 9,364,000 ms
});

test('dirty repo shows changed-file count on the branch', () => {
  const plain = stripAnsi(render({ git: { dirtyCount: 3 } }));
  assert.ok(plain.includes('develop +3'), plain);
});

test('worktree flag marks the branch segment', () => {
  const plain = stripAnsi(render({ git: { isWorktree: true } }));
  assert.ok(plain.includes('⎇'), plain);
});

test('activity cluster renders agents, workflows and processes when nonzero', () => {
  const plain = stripAnsi(render({ counts: { agents: 2, workflows: 1, procs: 3 } }));
  assert.ok(plain.includes('ag:2'), plain);
  assert.ok(plain.includes('wf:1'), plain);
  assert.ok(plain.includes('ps:3'), plain);
});

test('activity cluster is omitted when all zero', () => {
  const plain = stripAnsi(render());
  assert.ok(!plain.includes('ag:'), plain);
  assert.ok(!plain.includes('wf:'), plain);
});

test('open PR renders at wide widths and is dropped first when narrow', () => {
  const j = JSON.parse(SAMPLE);
  j.pr = { number: 6612, url: 'https://github.com/acme/my-repo/pull/6612' };
  const wide = stripAnsi(render({ status: parseStatus(JSON.stringify(j)) }));
  assert.ok(wide.includes('PR#6612'), wide);
  const narrow = stripAnsi(render({ status: parseStatus(JSON.stringify(j)), width: 80 }));
  assert.ok(!narrow.includes('PR#'), narrow);
});

test('native git_worktree field marks the branch even without git probe', () => {
  const j = JSON.parse(SAMPLE);
  j.workspace.git_worktree = 'gmail-native-tabs';
  const plain = stripAnsi(render({ status: parseStatus(JSON.stringify(j)) }));
  assert.ok(plain.includes('⎇'), plain);
});

// ---------- warnings ----------

test('critical usage adds a leading warning marker', () => {
  const j = JSON.parse(SAMPLE);
  j.rate_limits.five_hour.used_percentage = 96;
  const plain = stripAnsi(render({ status: parseStatus(JSON.stringify(j)) }));
  assert.ok(plain.startsWith('⚠ 5h'), plain);
});

test('near-full context adds a compaction warning', () => {
  const j = JSON.parse(SAMPLE);
  j.context_window.used_percentage = 93;
  const plain = stripAnsi(render({ status: parseStatus(JSON.stringify(j)) }));
  assert.ok(plain.includes('⚠ ctx'), plain);
});

// ---------- degradation / narrow widths ----------

test('never exceeds the given width', () => {
  for (const width of [40, 60, 80, 100, 120, 160, 200]) {
    const out = render({ width, counts: { agents: 2, workflows: 1, procs: 3 }, git: { dirtyCount: 12 } });
    assert.ok(displayWidth(out) <= width, `${width}: ${displayWidth(out)} ${stripAnsi(out)}`);
    assert.ok(!out.includes('\n'));
  }
});

test('at 80 cols bars degrade to percentages but 5h/7d survive', () => {
  const plain = stripAnsi(render({ width: 80, counts: { agents: 2, workflows: 1, procs: 3 } }));
  assert.ok(plain.includes('5h'), plain);
  assert.ok(plain.includes('7d'), plain);
  assert.ok(!plain.includes('█'), plain);
});

test('at 40 cols the essentials survive: branch and model', () => {
  const plain = stripAnsi(render({ width: 40 }));
  assert.ok(plain.includes('develop'), plain);
  assert.ok(plain.includes('Fable'), plain);
});

test('missing rate limits and context: segments omitted, no crash', () => {
  const s = parseStatus('{"model":{"display_name":"Sonnet 5"},"workspace":{"current_dir":"/x"}}');
  const plain = stripAnsi(render({ status: s }));
  assert.ok(!plain.includes('5h'), plain);
  assert.ok(!plain.includes('7d'), plain);
  assert.ok(!plain.includes('CTX'), plain);
  assert.ok(plain.includes('Sonnet 5'), plain);
});

// ---------- ascii mode ----------

test('ascii mode renders pure ASCII output', () => {
  const out = stripAnsi(
    render({
      config: { style: { ...defaultConfig().style, ascii: true } },
      counts: { agents: 1, workflows: 1, procs: 1 },
      git: { dirtyCount: 2, isWorktree: true },
    })
  );
  assert.ok(/^[\x20-\x7e]+$/.test(out), out);
  assert.ok(out.includes('###'), out);
});

test('unicode is the default', () => {
  assert.ok(render().includes('█'));
});
