import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripAnsi, displayWidth } from '../src/lib/ansi.mjs';

const ENTRY = new URL('../src/statusline.mjs', import.meta.url).pathname;
const SAMPLE = readFileSync(new URL('./fixtures/stdin-sample.json', import.meta.url), 'utf8');

function run(input, envOverrides = {}) {
  const hudDir = envOverrides.CLAUDE_HUD_DIR ?? mkdtempSync(join(tmpdir(), 'hud-sl-'));
  const res = spawnSync(process.execPath, [ENTRY], {
    input,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      COLUMNS: '150',
      CLAUDE_HUD_DIR: hudDir,
      CLAUDE_HUD_NO_PS: '1', // deterministic tests: skip live process scan
      ...envOverrides,
    },
    timeout: 10_000,
  });
  return { ...res, hudDir };
}

test('git dirty-count cache is not re-stamped on a hit, so its TTL actually elapses', () => {
  const hudDir = mkdtempSync(join(tmpdir(), 'hud-sl-'));
  const sessDir = join(hudDir, 'state', 'sessions');
  mkdirSync(sessDir, { recursive: true });
  const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const oldTs = Date.now() - 5000; // within the default 10s TTL -> should be a cache HIT
  writeFileSync(
    join(sessDir, `${sid}.json`),
    JSON.stringify({ sessionId: sid, gitCache: { cwd: '/Users/dev/code/my-repo', ts: oldTs, info: { branch: 'cached', dirtyCount: 7, isWorktree: false } } })
  );
  run(SAMPLE, { CLAUDE_HUD_DIR: hudDir });
  const after = JSON.parse(readFileSync(join(sessDir, `${sid}.json`), 'utf8'));
  assert.equal(after.gitCache.ts, oldTs, 'a cache hit must preserve the original timestamp, not re-stamp to now');
  assert.equal(after.gitCache.info.dirtyCount, 7, 'the cached dirty count was used');
});

test('default statusline renders the FULL session HUD (final design) and exits 0', () => {
  const { status, stdout } = run(SAMPLE);
  assert.equal(status, 0);
  const plain = stripAnsi(stdout);
  assert.ok(/WORKSPACE.*CONTEXT/.test(plain.split('\n')[1]), plain); // grid3: gauges rightmost (line 0 is the spacer)
  assert.ok(!/0 running/.test(plain), plain); // kinds with nothing running are hidden
  assert.ok(/MODEL\s+Fable 5/.test(plain), plain);
  assert.ok(/EFFORT\s+xhigh/.test(plain), plain);
  assert.ok(plain.includes('primary terminal') || plain.includes('worktree'), plain);
  assert.ok(/5-HOUR/.test(plain), plain);
  for (const row of stdout.replace(/\n$/, '').split('\n')) {
    assert.ok(displayWidth(row) <= 150, `${displayWidth(row)}: ${stripAnsi(row)}`);
  }
});

test('block mode is available behind config for anyone who wants the compact rows', () => {
  const hudDir = mkdtempSync(join(tmpdir(), 'hud-sl-'));
  writeFileSync(join(hudDir, 'config.json'), JSON.stringify({ statusline: { mode: 'block' } }));
  const { status, stdout } = run(SAMPLE, { CLAUDE_HUD_DIR: hudDir });
  assert.equal(status, 0);
  const rows = stdout.replace(/\n$/, '').split('\n');
  assert.equal(rows.length, 2);
  assert.ok(stripAnsi(rows[0]).includes('Fable 5'));
  assert.ok(stripAnsi(rows[1]).includes('5h'));
});

test('writes atomic session state with the parent pid as claudePid', () => {
  const { hudDir } = run(SAMPLE);
  const dir = join(hudDir, 'state', 'sessions');
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  const state = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
  assert.equal(state.sessionId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(state.claudePid, process.pid); // spawnSync parent = this test process
  assert.equal(state.model.name, 'Fable 5');
  assert.ok(state.renderMs >= 0);
  assert.ok(state.rateLimits.fiveHour.pct > 0);
});

test('honors legacy single-line mode from the hud dir', () => {
  const hudDir = mkdtempSync(join(tmpdir(), 'hud-sl-'));
  writeFileSync(join(hudDir, 'config.json'), JSON.stringify({ statusline: { mode: 'block' }, style: { layout: 'line' } }));
  const { stdout } = run(SAMPLE, { CLAUDE_HUD_DIR: hudDir });
  assert.equal(stdout.replace(/\n$/, '').split('\n').length, 1);
});

test('malformed stdin never crashes and never blocks', () => {
  const { status, stdout } = run('{definitely not json');
  assert.equal(status, 0);
  assert.ok(typeof stdout === 'string');
});

test('minimal payload renders whatever exists', () => {
  const { status, stdout } = run('{"model":{"display_name":"Sonnet 5"}}');
  assert.equal(status, 0);
  assert.ok(stripAnsi(stdout).includes('Sonnet 5'));
});

test('NO_COLOR strips ANSI', () => {
  const { stdout } = run(SAMPLE, { NO_COLOR: '1' });
  assert.ok(!stdout.includes('\x1b'), JSON.stringify(stdout.slice(0, 80)));
});

test('COLUMNS=0 falls back to a sane width', () => {
  const { stdout, status } = run(SAMPLE, { COLUMNS: '0' });
  assert.equal(status, 0);
  for (const row of stdout.replace(/\n$/, '').split('\n')) {
    assert.ok(displayWidth(row) <= 120, stripAnsi(row));
  }
});

test('render is fast enough for continuous use (well under the 5s kill)', () => {
  const t0 = Date.now();
  run(SAMPLE);
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `render took ${ms}ms`); // includes node cold start in CI
});
