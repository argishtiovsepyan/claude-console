// Readers over Claude Code's own runtime session registry:
//   ~/.claude/sessions/<pid>.json  — one file per running interactive CLI,
//   with cwd, sessionId, human name, busy/idle status and updatedAt heartbeat
//   (verified on v2.1.206).
// mergeSessionSources unions that registry with the HUD's own per-render
// state files, which carry the rich data (model, context, rate limits, git).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readSessionRegistry(claudeDir) {
  const dir = join(claudeDir, 'sessions');
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (j && typeof j === 'object') out.push(j);
    } catch {
      // torn/corrupt — skip
    }
  }
  return out;
}

function pidAlive(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function mergeSessionSources({ registry = [], states = [], isAlive = pidAlive } = {}) {
  const byId = new Map();

  for (const r of registry) {
    if (!r.sessionId) continue;
    byId.set(r.sessionId, {
      sessionId: r.sessionId,
      pid: r.pid ?? null,
      cwd: r.cwd ?? null,
      name: r.name ?? null,
      registryStatus: r.status ?? null,
      updatedAt: r.updatedAt ?? null,
      startedAt: r.startedAt ?? null,
      fromRegistry: true,
    });
  }

  for (const s of states) {
    if (!s.sessionId) continue;
    const base = byId.get(s.sessionId) ?? {
      sessionId: s.sessionId,
      pid: s.claudePid ?? null,
      cwd: s.cwd ?? null,
      name: s.sessionName ?? null,
      registryStatus: null,
      updatedAt: s.updatedAt ?? null,
      startedAt: s.startedAt ?? null,
      fromRegistry: false,
    };
    byId.set(s.sessionId, {
      ...base,
      pid: base.pid ?? s.claudePid ?? null,
      // state cwd is fresher (follows the session's cd); registry cwd is the
      // launch dir — prefer state so WHERE describes one coherent location
      cwd: s.cwd ?? base.cwd ?? null,
      // the session_name Claude pipes to the statusline is the human-visible
      // one; registry names are often auto-generated slugs
      name: s.sessionName ?? base.name ?? null,
      updatedAt: Math.max(base.updatedAt ?? 0, s.updatedAt ?? 0) || base.updatedAt,
      startedAt: base.startedAt ?? s.startedAt ?? null,
      state: s,
      model: s.model ?? null,
      branch: s.branch ?? null,
      isWorktree: s.isWorktree ?? false,
      context: s.context ?? null,
      rateLimits: s.rateLimits ?? null,
      cost: s.cost ?? null,
      counts: s.counts ?? null,
      transcriptPath: s.transcriptPath ?? null,
      pr: s.pr ?? null,
      effort: s.effort ?? null,
    });
  }

  const merged = [...byId.values()].map((s) => ({ ...s, alive: isAlive(s.pid) }));
  merged.sort((a, b) => (Number(b.alive) - Number(a.alive)) || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
  return merged;
}
