import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePsOutput,
  findClaudeSessions,
  buildChildrenMap,
  descendantsOf,
  classifyProcess,
  parseEtimeMs,
  parseLsofCwd,
} from '../src/lib/procs.mjs';

// Shaped after the real recon observations on this machine.
const PS = `
 8155 97195  8155 ttys008 02:03:04 claude --dangerously-skip-permissions
21132 90001 21132 ttys001 1-02:03:04 claude --dangerously-skip-permissions
72352  8155 72352 ??      00:12 zsh -c source /Users/dev/.claude/shell-snapshots/snap.sh && eval 'git status' < /dev/null
73000 72352 72352 ??      00:11 git status
74001  8155 74001 ??      45:00 npm exec tools/repo-intel/src/cli.ts serve-mcp
74002 74001 74001 ??      44:59 node /x/tsx tools/repo-intel/src/cli.ts serve-mcp
75001  8155 75001 ??      33:00 node /Users/dev/x/typescript-language-server --stdio
 7867     1  7867 ??      05:01:02 npm run start-dev
 7900  7867  7900 ??      05:01:01 node /Users/dev/code/xavior-core-1/.claude/worktrees/fix-thing/node_modules/.bin/vite
99999 97195 99999 ttys009 00:01 grep -i claude
`.trim();

test('parsePsOutput parses pid/ppid/pgid/tty/etime/command', () => {
  const rows = parsePsOutput(PS);
  assert.equal(rows.length, 10);
  assert.equal(rows[0].pid, 8155);
  assert.equal(rows[0].ppid, 97195);
  assert.equal(rows[0].tty, 'ttys008');
  assert.equal(rows[0].command, 'claude --dangerously-skip-permissions');
});

test('findClaudeSessions matches real claude CLIs only (no .claude-path false positives)', () => {
  const rows = parsePsOutput(PS);
  const sessions = findClaudeSessions(rows);
  assert.deepEqual(sessions.map((s) => s.pid).sort((a, b) => a - b), [8155, 21132]);
});

test('descendantsOf walks the whole subtree', () => {
  const rows = parsePsOutput(PS);
  const kids = descendantsOf(buildChildrenMap(rows), 8155).map((r) => r.pid).sort((a, b) => a - b);
  assert.deepEqual(kids, [72352, 73000, 74001, 74002, 75001]);
});

test('classifyProcess distinguishes shell-tool commands from MCP/LSP helpers', () => {
  const rows = parsePsOutput(PS);
  const byPid = Object.fromEntries(rows.map((r) => [r.pid, r]));
  assert.equal(classifyProcess(byPid[72352]).kind, 'shell');
  assert.equal(classifyProcess(byPid[73000]).kind, 'command');
  assert.equal(classifyProcess(byPid[74001]).kind, 'mcp');
  assert.equal(classifyProcess(byPid[75001]).kind, 'lsp');
});

test('parseEtimeMs handles mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
  assert.equal(parseEtimeMs('00:12'), 12_000);
  assert.equal(parseEtimeMs('45:00'), 45 * 60_000);
  assert.equal(parseEtimeMs('02:03:04'), ((2 * 60 + 3) * 60 + 4) * 1000);
  assert.equal(parseEtimeMs('1-02:03:04'), 24 * 3600_000 + ((2 * 60 + 3) * 60 + 4) * 1000);
  assert.equal(parseEtimeMs('garbage'), null);
});

test('parseLsofCwd maps pids to cwd paths from -Fn output', () => {
  const out = 'p8155\nfcwd\nn/Users/dev/code/xavior-core-1\np21132\nfcwd\nn/Users/dev/code/xavior-core-1/.claude/worktrees/fix-x\n';
  const map = parseLsofCwd(out);
  assert.equal(map.get(8155), '/Users/dev/code/xavior-core-1');
  assert.equal(map.get(21132), '/Users/dev/code/xavior-core-1/.claude/worktrees/fix-x');
});
