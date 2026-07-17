import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, utimesSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeStore } from '../src/lib/state.mjs';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'hud-state-'));
  return { store: makeStore(dir), dir };
}

test('writes and reads session state round-trip', () => {
  const { store } = freshStore();
  store.writeSession({ sessionId: 'abc', claudePid: 123, cwd: '/x', updatedAt: 1000 });
  const all = store.readSessions();
  assert.equal(all.length, 1);
  assert.equal(all[0].sessionId, 'abc');
  assert.equal(all[0].claudePid, 123);
});

test('session state files are private (0600)', () => {
  const { store } = freshStore();
  const file = store.writeSession({ sessionId: 'priv', updatedAt: 1 });
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode & 0o077, 0, `state mode ${mode.toString(8)}`);
});

test('preserves startedAt across rewrites', () => {
  const { store } = freshStore();
  store.writeSession({ sessionId: 's1', updatedAt: 1000 });
  const first = store.readSessions()[0];
  store.writeSession({ sessionId: 's1', updatedAt: 2000 });
  const second = store.readSessions()[0];
  assert.equal(second.startedAt, first.startedAt);
  assert.equal(second.updatedAt, 2000);
});

test('skips corrupt state files without throwing', () => {
  const { store, dir } = freshStore();
  store.writeSession({ sessionId: 'good', updatedAt: 1 });
  writeFileSync(join(dir, 'state', 'sessions', 'bad.json'), '{torn');
  const all = store.readSessions();
  assert.equal(all.length, 1);
  assert.equal(all[0].sessionId, 'good');
});

test('atomic writes: concurrent writers never leave a torn file', async () => {
  const { store, dir } = freshStore();
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      Promise.resolve().then(() =>
        store.writeSession({ sessionId: 'race', payload: 'x'.repeat(2000 + i), updatedAt: i })
      )
    )
  );
  const raw = readFileSync(join(dir, 'state', 'sessions', 'race.json'), 'utf8');
  const parsed = JSON.parse(raw); // must always parse
  assert.equal(parsed.sessionId, 'race');
});

test('gcStale removes dead-pid old files and keeps live ones', () => {
  const { store, dir } = freshStore();
  // definitely-dead pid (kill(pid,0) fails), old mtime
  store.writeSession({ sessionId: 'dead', claudePid: 999999999, updatedAt: 1 });
  // our own pid = alive
  store.writeSession({ sessionId: 'live', claudePid: process.pid, updatedAt: 1 });
  const sessions = join(dir, 'state', 'sessions');
  const old = new Date(Date.now() - 3 * 3600_000);
  for (const f of readdirSync(sessions)) utimesSync(join(sessions, f), old, old);

  const removed = store.gcStale({ olderThanMs: 3600_000 });
  const left = store.readSessions().map((s) => s.sessionId);
  assert.deepEqual(left, ['live']);
  assert.equal(removed.length, 1);
});

test('gcStale keeps recent files even with dead pids (grace period)', () => {
  const { store } = freshStore();
  store.writeSession({ sessionId: 'recent-dead', claudePid: 999999999, updatedAt: 1 });
  const removed = store.gcStale({ olderThanMs: 3600_000 });
  assert.equal(removed.length, 0);
  assert.equal(store.readSessions().length, 1);
});

test('isAlive detects the current process and rejects a bogus pid', () => {
  const { store } = freshStore();
  assert.equal(store.isAlive(process.pid), true);
  assert.equal(store.isAlive(999999999), false);
});

test('gcStale removes orphaned .tmp files quickly even when the owner pid is alive', () => {
  const { store, dir } = freshStore();
  store.writeSession({ sessionId: 'x', claudePid: process.pid, updatedAt: 1 });
  const sessions = join(dir, 'state', 'sessions');
  const orphan = join(sessions, 'x.json.123.deadbeef.tmp');
  writeFileSync(orphan, JSON.stringify({ sessionId: 'x', claudePid: process.pid }));
  const old = new Date(Date.now() - 30 * 60_000); // 30min — under gc age, over tmp age
  utimesSync(orphan, old, old);
  const removed = store.gcStale({ olderThanMs: 6 * 3600_000 });
  assert.deepEqual(removed, ['x.json.123.deadbeef.tmp']);
  assert.equal(store.readSessions().length, 1); // real file untouched
});

test('readSessions tolerates an unusable base dir without throwing', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hud-badbase-')), 'a-plain-file');
  writeFileSync(file, 'not a dir');
  const store = makeStore(file); // state dir cannot be created under a file
  assert.deepEqual(store.readSessions(), []);
});
