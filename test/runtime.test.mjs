import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionRegistry, mergeSessionSources } from '../src/lib/runtime.mjs';

function makeClaudeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'hud-claude-'));
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  return dir;
}

test('readSessionRegistry parses pid-keyed session files and skips corrupt ones', () => {
  const dir = makeClaudeDir();
  writeFileSync(
    join(dir, 'sessions', '8155.json'),
    JSON.stringify({ pid: 8155, sessionId: 's-1', cwd: '/repo', name: 'Build HUD', status: 'busy', updatedAt: 1000, startedAt: 900 })
  );
  writeFileSync(join(dir, 'sessions', '9999.json'), '{torn');
  const reg = readSessionRegistry(dir);
  assert.equal(reg.length, 1);
  assert.equal(reg[0].pid, 8155);
  assert.equal(reg[0].status, 'busy');
});

test('readSessionRegistry tolerates a missing dir', () => {
  assert.deepEqual(readSessionRegistry('/nonexistent/claude'), []);
});

test('mergeSessionSources unions registry + hud state, keyed by sessionId', () => {
  const registry = [
    { pid: process.pid, sessionId: 's-live', cwd: '/repo', name: 'Live one', status: 'busy', updatedAt: 5000 },
    { pid: 999999999, sessionId: 's-dead', cwd: '/repo2', name: 'Dead one', status: 'idle', updatedAt: 1000 },
  ];
  const states = [
    { sessionId: 's-live', claudePid: process.pid, cwd: '/repo', model: { name: 'Fable 5' }, branch: 'develop', updatedAt: 5100 },
    { sessionId: 's-stateonly', claudePid: 999999998, cwd: '/x', model: { name: 'Sonnet 5' }, updatedAt: 200 },
  ];
  const merged = mergeSessionSources({ registry, states });
  const byId = Object.fromEntries(merged.map((s) => [s.sessionId, s]));

  assert.equal(byId['s-live'].alive, true);
  assert.equal(byId['s-live'].model.name, 'Fable 5'); // state enriches registry
  assert.equal(byId['s-live'].name, 'Live one');
  assert.equal(byId['s-live'].registryStatus, 'busy');

  assert.equal(byId['s-dead'].alive, false);
  assert.equal(byId['s-stateonly'].alive, false);
  assert.equal(byId['s-stateonly'].model.name, 'Sonnet 5');
});

test('startedAt from state survives the merge when a registry entry exists', () => {
  const merged = mergeSessionSources({
    registry: [{ pid: process.pid, sessionId: 's-1', cwd: '/r', updatedAt: 100 }],
    states: [{ sessionId: 's-1', claudePid: process.pid, startedAt: 42, updatedAt: 200 }],
  });
  assert.equal(merged[0].startedAt, 42);
});

test('the human session name from state beats the registry auto-name', () => {
  const merged = mergeSessionSources({
    registry: [{ pid: process.pid, sessionId: 's-1', cwd: '/r', name: 'xavior-core-1-66', updatedAt: 100 }],
    states: [{ sessionId: 's-1', claudePid: process.pid, sessionName: 'Build the terminal HUD', updatedAt: 200 }],
  });
  assert.equal(merged[0].name, 'Build the terminal HUD');
});

test('merged sessions sort live-first then by recency', () => {
  const merged = mergeSessionSources({
    registry: [
      { pid: 999999999, sessionId: 'dead-recent', cwd: '/a', updatedAt: 9000 },
      { pid: process.pid, sessionId: 'live-old', cwd: '/b', updatedAt: 100 },
    ],
    states: [],
  });
  assert.deepEqual(merged.map((s) => s.sessionId), ['live-old', 'dead-recent']);
});
