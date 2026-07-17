import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

const ORIGINAL_STATUSLINE = { type: 'command', command: 'bash "$HOME/.claude/statusline-command.sh"' };

function makeHome({ withExistingStatusline = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hud-inst-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const settings = {
    model: 'claude-fable-5[1m]',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    ...(withExistingStatusline ? { statusLine: ORIGINAL_STATUSLINE } : {}),
  };
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  return home;
}

function run(args, home) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, NO_COLOR: '1' },
    timeout: 30_000,
  });
}

const readSettings = (home) => JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));

test('rollback restores only statusLine, preserving settings the user added since', () => {
  const home = makeHome();
  run(['install'], home);
  const s = readSettings(home);
  s.newHook = 'added-after-install'; // unrelated key added after install
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(s, null, 2));
  const res = run(['rollback'], home);
  assert.equal(res.status, 0, res.stderr);
  const after = readSettings(home);
  assert.equal(after.newHook, 'added-after-install', 'an unrelated key must survive rollback');
  assert.deepEqual(after.statusLine, ORIGINAL_STATUSLINE, 'statusLine should roll back to the pre-install original');
  assert.equal(after.model, 'claude-fable-5[1m]', 'other keys untouched');
});

test('non-purge uninstall clears the recorded original so a later install re-baselines', () => {
  const home = makeHome();
  run(['install'], home);
  const rec = join(home, '.claude', 'hud', 'original-statusline.json');
  assert.ok(existsSync(rec), 'original recorded on install');
  run(['uninstall'], home);
  assert.ok(!existsSync(rec), 'original record cleared on non-purge uninstall');
});

test('install copies the app, points statusLine at the shim, and backs up settings', () => {
  const home = makeHome();
  const res = run(['install'], home);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.ok(existsSync(join(home, '.claude', 'hud', 'app', 'statusline.mjs')));
  assert.ok(existsSync(join(home, '.claude', 'hud', 'bin', 'statusline.sh')));
  assert.ok(existsSync(join(home, '.claude', 'hud', 'manifest.json')));
  const s = readSettings(home);
  assert.ok(s.statusLine.command.includes('hud/bin/statusline.sh'), JSON.stringify(s.statusLine));
  assert.equal(s.statusLine.refreshInterval, 1); // real-time status/age updates
  // untouched settings survive
  assert.equal(s.model, 'claude-fable-5[1m]');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo hi');
  // backup + original recorded
  const backups = readdirSync(join(home, '.claude', 'hud', 'backups'));
  assert.ok(backups.some((f) => f.startsWith('settings.json.')), backups.join(','));
  const orig = JSON.parse(readFileSync(join(home, '.claude', 'hud', 'original-statusline.json'), 'utf8'));
  assert.deepEqual(orig.statusLine, ORIGINAL_STATUSLINE);
  // report says what changed
  assert.ok(/statusLine/.test(res.stdout), res.stdout);
});

test('the installed statusline shim renders end-to-end', () => {
  const home = makeHome();
  run(['install'], home);
  const sample = readFileSync(new URL('./fixtures/stdin-sample.json', import.meta.url), 'utf8');
  const res = spawnSync('bash', [join(home, '.claude', 'hud', 'bin', 'statusline.sh')], {
    input: sample,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, COLUMNS: '150', CLAUDE_HUD_NO_PS: '1' },
    timeout: 15_000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('Fable 5'), res.stdout);
  assert.ok(res.stdout.split('\n').filter(Boolean).length >= 2, res.stdout);
});

test('install is idempotent: rerun keeps original-statusline.json from the first run', () => {
  const home = makeHome();
  run(['install'], home);
  const before = readFileSync(join(home, '.claude', 'hud', 'original-statusline.json'), 'utf8');
  const res = run(['install'], home);
  assert.equal(res.status, 0, res.stderr);
  const after = readFileSync(join(home, '.claude', 'hud', 'original-statusline.json'), 'utf8');
  assert.equal(after, before); // second install must NOT overwrite the recorded original
  const s = readSettings(home);
  assert.ok(s.statusLine.command.includes('hud/bin/statusline.sh'));
});

test('install never deletes a pre-existing non-claude-console file at ~/.local/bin/claude-console', () => {
  const home = makeHome();
  const localBin = join(home, '.local', 'bin');
  mkdirSync(localBin, { recursive: true });
  writeFileSync(join(localBin, 'claude-console'), 'precious user binary');
  const res = run(['install'], home);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(join(localBin, 'claude-console'), 'utf8'), 'precious user binary');
  assert.ok(/left untouched|not claude-console/i.test(res.stdout), res.stdout);
});

test('install aborts without touching a corrupt settings.json', () => {
  const home = makeHome();
  writeFileSync(join(home, '.claude', 'settings.json'), '{corrupt json!!');
  const res = run(['install'], home);
  assert.notEqual(res.status, 0);
  assert.equal(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'), '{corrupt json!!');
  assert.ok(/not valid JSON|corrupt/i.test(res.stdout + res.stderr), res.stdout + res.stderr);
});

test('settings backups are private (0600)', () => {
  const home = makeHome();
  run(['install'], home);
  const dir = join(home, '.claude', 'hud', 'backups');
  const f = readdirSync(dir).find((x) => x.startsWith('settings.json.'));
  const mode = statSync(join(dir, f)).mode & 0o777;
  assert.equal(mode & 0o077, 0, `backup mode ${mode.toString(8)}`);
});

test('rapid consecutive installs never overwrite an earlier settings backup', () => {
  const home = makeHome();
  run(['install'], home);
  run(['install'], home);
  run(['install'], home);
  const backups = readdirSync(join(home, '.claude', 'hud', 'backups')).filter((f) => f.startsWith('settings.json.'));
  assert.equal(backups.length, 3, backups.join(','));
});

test('verify passes after install and fails after tampering', () => {
  const home = makeHome();
  run(['install'], home);
  assert.equal(run(['verify'], home).status, 0);
  writeFileSync(join(home, '.claude', 'hud', 'app', 'lib', 'bars.mjs'), '// tampered\n');
  const res = run(['verify'], home);
  assert.notEqual(res.status, 0);
  assert.ok(/checksum|mismatch|tamper/i.test(res.stdout + res.stderr), res.stdout + res.stderr);
});

test('uninstall restores the original statusLine byte-identically', () => {
  const home = makeHome();
  const originalRaw = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
  run(['install'], home);
  const res = run(['uninstall'], home);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const restored = readSettings(home);
  assert.deepEqual(restored.statusLine, JSON.parse(originalRaw).statusLine);
  assert.equal(restored.model, 'claude-fable-5[1m]');
});

test('uninstall removes statusLine entirely when none existed before', () => {
  const home = makeHome({ withExistingStatusline: false });
  run(['install'], home);
  assert.ok(readSettings(home).statusLine);
  run(['uninstall'], home);
  assert.equal(readSettings(home).statusLine, undefined);
});

test('rollback restores the most recent settings backup', () => {
  const home = makeHome();
  run(['install'], home);
  // simulate a bad manual edit after install
  const s = readSettings(home);
  s.statusLine = { type: 'command', command: 'broken' };
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(s, null, 2));
  const res = run(['rollback'], home);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.deepEqual(readSettings(home).statusLine, ORIGINAL_STATUSLINE);
});

test('doctor reports environment health', () => {
  const home = makeHome();
  run(['install'], home);
  const res = run(['doctor'], home);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(/node/i.test(res.stdout), res.stdout);
  assert.ok(/settings/i.test(res.stdout), res.stdout);
});
