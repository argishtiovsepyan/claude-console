import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

// Build a fake $HOME with a claude runtime: session registry + hud state +
// transcript, so the CLI has real (fixture) sources to read.
function makeHome({ name = 'Fixture session' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hud-home-'));
  const claude = join(home, '.claude');
  const sessionId = 'aaaaaaaa-1111-2222-3333-444444444444';
  const cwd = '/Users/dev/code/my-repo';
  const slug = '-Users-dev-code-my-repo';
  const projDir = join(claude, 'projects', slug);
  const sessionDir = join(projDir, sessionId);
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  mkdirSync(join(claude, 'hud', 'state', 'sessions'), { recursive: true });
  mkdirSync(join(sessionDir, 'subagents'), { recursive: true });

  const transcript = join(projDir, `${sessionId}.jsonl`);
  const ts = new Date().toISOString();
  writeFileSync(
    transcript,
    [
      JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: {
          role: 'assistant',
          model: 'claude-fable-5',
          content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'verify' } }],
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 },
        },
      }),
    ].join('\n') + '\n'
  );
  writeFileSync(
    join(claude, 'sessions', '4242.json'),
    JSON.stringify({ pid: process.pid, sessionId, cwd, name, status: 'busy', updatedAt: Date.now() })
  );
  writeFileSync(
    join(claude, 'hud', 'state', 'sessions', `${sessionId}.json`),
    JSON.stringify({
      v: 1,
      sessionId,
      sessionName: name,
      claudePid: process.pid,
      cwd,
      transcriptPath: transcript,
      model: { id: 'claude-fable-5', name: 'Fable 5' },
      effort: 'xhigh',
      branch: 'develop',
      dirtyCount: 2,
      isWorktree: false,
      context: { usedPct: 12, totalIn: 120259, size: 1000000 },
      rateLimits: { fiveHour: { pct: 55, resetsAt: 1784259600 }, sevenDay: { pct: 11, resetsAt: 1784386800 } },
      cost: { usd: 1.23, durationMs: 60000 },
      updatedAt: Date.now(),
      startedAt: Date.now() - 60000,
    })
  );
  return { home, sessionId };
}

function run(args, home) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, NO_COLOR: '1', CLAUDE_HUD_NO_PS: '1' },
    timeout: 15_000,
  });
}

test('default view renders the deep session view from fixture sources', () => {
  const { home } = makeHome();
  const res = run([], home);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!res.stdout.includes('WHAT'), res.stdout);
  assert.ok(/MODEL\s+Fable 5/.test(res.stdout), res.stdout);
  assert.ok(res.stdout.includes('main terminal'), res.stdout);
  assert.ok(res.stdout.includes('develop'), res.stdout);
  // skills + failures are hidden by default (user preference; config-toggleable)
  assert.ok(!res.stdout.includes('SKILLS USED'), res.stdout);
  assert.ok(!res.stdout.includes('FAILURES'), res.stdout);
});

test('--session selects by id prefix', () => {
  const { home, sessionId } = makeHome();
  const res = run(['--session', sessionId.slice(0, 8)], home);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(/MODEL\s+Fable 5/.test(res.stdout), res.stdout);
});

test('--json emits machine-readable session data', () => {
  const { home, sessionId } = makeHome();
  const res = run(['--json'], home);
  assert.equal(res.status, 0, res.stderr);
  const j = JSON.parse(res.stdout);
  assert.equal(j.sessionId, sessionId);
  assert.equal(j.model.name, 'Fable 5');
  assert.ok(Array.isArray(j.skills));
});

test('--json redacts the session name (no secret leaks in machine output)', () => {
  const { home } = makeHome({ name: 'deploy AKIAIOSFODNN7EXAMPLE now' });
  const res = run(['--json'], home);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!res.stdout.includes('AKIAIOSFODNN7EXAMPLE'), res.stdout);
});

test('--all lists every known session compactly', () => {
  const { home } = makeHome();
  const res = run(['--all'], home);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('Fixture session'), res.stdout);
  assert.ok(res.stdout.includes('develop'), res.stdout);
});

test('--json stays machine-readable when no sessions exist', () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-empty-json-'));
  const res = run(['--json'], home);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout), null);
});

test('no sessions found is a clear message, not a crash', () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-empty-'));
  const res = run([], home);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(/no claude sessions found/i.test(res.stdout), res.stdout);
});

test('a string flag before a subcommand does not swallow the subcommand (regression)', () => {
  const { home } = makeHome();
  const res = run(['--session', 'zzzzzzzz', 'doctor'], home);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(/node\s+v/i.test(res.stdout), res.stdout); // doctor ran, not the session view
  assert.ok(!/no claude sessions found/i.test(res.stdout), res.stdout);
});

test('--watch restores the alternate screen on SIGTERM', async () => {
  const { spawn } = await import('node:child_process');
  const { home } = makeHome();
  const child = spawn(process.execPath, [CLI, '--watch', '--interval', '1'], {
    env: { PATH: process.env.PATH, HOME: home, NO_COLOR: '1', CLAUDE_HUD_NO_PS: '1' },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((r) => setTimeout(r, 700));
  child.kill('SIGTERM');
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0);
  assert.ok(out.includes('\x1b[?1049h'), JSON.stringify(out.slice(0, 40)));
  assert.ok(out.includes('\x1b[?1049l'), 'alt screen not restored');
});

test('--help prints usage', () => {
  const { home } = makeHome();
  const res = run(['--help'], home);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('claude-console'), res.stdout);
  assert.ok(res.stdout.includes('--watch'), res.stdout);
});
