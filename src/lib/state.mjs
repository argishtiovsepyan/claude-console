// Multi-session state store under <hud dir>/state/sessions/<session>.json.
// One writer per session (that session's own statusline render); readers are
// claude-console and other sessions. Writes are atomic (tmp + rename) so readers
// can never observe a torn file. GC only removes files whose owning claude
// process is gone AND whose file is old — never a live session's state.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

function sanitizeId(id) {
  return String(id ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

export function makeStore(baseDir) {
  const sessionsDir = join(baseDir, 'state', 'sessions');

  function ensure() {
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  }

  function writeSession(session) {
    ensure();
    const file = join(sessionsDir, `${sanitizeId(session.sessionId)}.json`);
    let startedAt = session.startedAt ?? null;
    if (startedAt === null) {
      try {
        startedAt = JSON.parse(readFileSync(file, 'utf8')).startedAt ?? null;
      } catch {
        // first write for this session
      }
    }
    if (startedAt === null) startedAt = session.updatedAt ?? Date.now();
    const payload = JSON.stringify({ v: 1, ...session, startedAt });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, payload, { mode: 0o600 });
    renameSync(tmp, file);
    return file;
  }

  function readSessions() {
    const out = [];
    let files;
    try {
      ensure();
      files = readdirSync(sessionsDir);
    } catch {
      return out; // unusable state dir — behave as "no sessions", never throw
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(sessionsDir, f), 'utf8')));
      } catch {
        // torn/corrupt file — skip, GC will collect it once old
      }
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function isAlive(pid) {
    const p = Number(pid);
    if (!Number.isInteger(p) || p <= 0) return false;
    try {
      process.kill(p, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  }

  function gcStale({ olderThanMs = 6 * 3600_000, now = Date.now() } = {}) {
    ensure();
    const removed = [];
    for (const f of readdirSync(sessionsDir)) {
      if (!f.endsWith('.json') && !f.endsWith('.tmp')) continue;
      const p = join(sessionsDir, f);
      try {
        const st = statSync(p);
        if (f.endsWith('.tmp')) {
          // a .tmp that outlived its write window is an orphan from a failed
          // rename — collect fast, regardless of owner liveness
          if (now - st.mtimeMs > 15 * 60_000) {
            rmSync(p);
            removed.push(f);
          }
          continue;
        }
        if (now - st.mtimeMs < olderThanMs) continue;
        let pid = null;
        try {
          pid = JSON.parse(readFileSync(p, 'utf8')).claudePid ?? null;
        } catch {
          // corrupt and old -> removable
        }
        if (pid !== null && isAlive(pid)) continue;
        rmSync(p);
        removed.push(f);
      } catch {
        // raced with a writer/another GC — fine
      }
    }
    return removed;
  }

  return { baseDir, sessionsDir, writeSession, readSessions, isAlive, gcStale };
}
