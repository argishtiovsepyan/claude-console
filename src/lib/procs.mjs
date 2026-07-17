// Process-table scanning for Claude Code sessions and their children.
// Matching is strict on argv[0] basename === 'claude' — plain substring
// matching false-positives on any process whose argv merely contains a
// `.claude/worktrees/...` path (observed on this machine).

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

export function parsePsOutput(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      tty: m[4],
      etime: m[5],
      command: m[6].trim(),
    });
  }
  return rows;
}

export function findClaudeSessions(rows) {
  return rows.filter((r) => {
    const argv0 = r.command.split(' ')[0];
    return basename(argv0) === 'claude';
  });
}

export function buildChildrenMap(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.ppid)) map.set(r.ppid, []);
    map.get(r.ppid).push(r);
  }
  return map;
}

export function descendantsOf(childrenMap, rootPid) {
  const out = [];
  const queue = [...(childrenMap.get(rootPid) ?? [])];
  while (queue.length) {
    const row = queue.shift();
    out.push(row);
    queue.push(...(childrenMap.get(row.pid) ?? []));
  }
  return out;
}

export function classifyProcess(row) {
  const cmd = row.command;
  if (cmd.includes('shell-snapshots') || /(^|\/)(zsh|bash|sh)\s+-c(\s|$)/.test(cmd)) {
    return { kind: 'shell' };
  }
  if (/\bserve-mcp\b|\bmcp\b/i.test(cmd)) return { kind: 'mcp' };
  if (/language-server|tsserver/.test(cmd)) return { kind: 'lsp' };
  if (/^caffeinate\b/.test(cmd)) return { kind: 'helper' };
  return { kind: 'command' };
}

export function parseEtimeMs(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(etime).trim());
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return (
    (Number(dd || 0) * 24 + Number(hh || 0)) * 3600_000 + Number(mm) * 60_000 + Number(ss) * 1000
  );
}

export function parseLsofCwd(text) {
  const map = new Map();
  let pid = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) map.set(pid, line.slice(1));
  }
  return map;
}

// ---- live runners (thin wrappers, excluded from unit tests) ----

export function snapshotProcesses() {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,tty=,etime=,command='], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parsePsOutput(out);
  } catch {
    return [];
  }
}

// Count live descendants of a pid (the statusline's "ps:" figure), excluding
// the caller's own subtree.
export function countLiveDescendants(rootPid, { excludePid = process.pid } = {}) {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1500 });
    const children = new Map();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
    let count = 0;
    const queue = [...(children.get(rootPid) ?? [])];
    while (queue.length) {
      const pid = queue.shift();
      if (pid === excludePid) continue;
      count++;
      queue.push(...(children.get(pid) ?? []));
    }
    return count;
  } catch {
    return 0;
  }
}

export function cwdOfPids(pids) {
  if (!pids.length) return new Map();
  try {
    const out = execFileSync('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return parseLsofCwd(out);
  } catch {
    return new Map();
  }
}
