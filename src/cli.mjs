#!/usr/bin/env node
// claude-console CLI.
//   claude-console                 deep view of the session you're in
//   claude-console --all           one line per session on this machine
//   claude-console --watch         live refresh (q or Ctrl-C to exit)
//   claude-console --json          machine-readable session data
//   claude-console --session <id>  explicit session (id prefix ok)
//   claude-console install|update|verify|doctor|rollback|uninstall

import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './lib/config.mjs';
import { makeStore } from './lib/state.mjs';
import { readSessionRegistry, mergeSessionSources } from './lib/runtime.mjs';
import { renderSessionView, pickSession, formatAge } from './lib/hud.mjs';
import { gitInfo } from './lib/gitinfo.mjs';
import { displayWidth, truncateDisplay, padEndDisplay } from './lib/ansi.mjs';
import {
  slugForCwd,
  listAgents,
  listWorkflows,
  recentSkills,
  recentFailures,
  inFlightBash,
  lastActivityTs,
  detectEffortOverride,
} from './lib/transcript.mjs';
import { install, verify, rollback, uninstall, doctor } from './lib/installer.mjs';
import { redact } from './lib/redact.mjs';

const HELP = `claude-console — deep observability for the Claude Code session you're in

USAGE
  claude-console                 deep view of the current session
  claude-console --all           compact list of every session on this machine
  claude-console --watch [-n s]  live refresh (Ctrl-C to exit)
  claude-console --json          machine-readable session data
  claude-console --session <id>  pick a session explicitly (id prefix ok)
  claude-console --ascii         plain-ASCII output; --no-color disables ANSI

MAINTENANCE
  claude-console install|update  install/refresh (backs up settings first)
  claude-console verify          checksums + settings wiring + live render test
  claude-console doctor          environment & data-source health report
  claude-console rollback        restore the most recent settings backup
  claude-console uninstall       restore the pre-install statusline (--purge removes all)
`;

function collectSessions({ home, hudDir }) {
  const store = makeStore(hudDir);
  const registry = readSessionRegistry(join(home, '.claude'));
  const states = store.readSessions();
  return mergeSessionSources({ registry, states });
}

function buildSessionData(session, { home, now }) {
  const claudeDir = join(home, '.claude');
  const cwd = session.cwd ?? null;
  const safeSessionId = session.sessionId ? String(session.sessionId).replace(/[^A-Za-z0-9._-]/g, '') : null;
  const transcriptPath =
    session.transcriptPath ??
    (cwd && safeSessionId ? join(claudeDir, 'projects', slugForCwd(cwd), `${safeSessionId}.jsonl`) : null);
  const sessionDir = transcriptPath ? transcriptPath.replace(/\.jsonl$/, '') : null;

  let branch = session.branch ?? null;
  let dirtyCount = session.state?.dirtyCount ?? null;
  let isWorktree = session.isWorktree ?? false;
  if (branch === null && cwd) {
    const g = gitInfo(cwd);
    branch = g.branch;
    dirtyCount = g.dirtyCount;
    isWorktree = g.isWorktree;
  }

  return {
    sessionId: session.sessionId,
    name: session.name,
    alive: session.alive,
    registryStatus: session.registryStatus,
    pid: session.pid,
    cwd,
    model: session.model ?? { id: null, name: null },
    effort: (() => {
      const base = session.effort ?? null;
      if (base !== 'xhigh') return base;
      const override =
        session.state?.effortOverride ??
        (transcriptPath ? detectEffortOverride(transcriptPath, { maxBytes: 8 * 1024 * 1024 }) : null);
      return override === 'ultracode' ? 'ultracode' : base;
    })(),
    branch,
    dirtyCount,
    isWorktree,
    worktreeName: session.state?.worktreeName ?? (isWorktree && cwd ? basename(cwd) : null),
    repo: session.state?.repo ?? null,
    pr: session.pr ?? null,
    cost: session.cost ?? null,
    context: session.context ?? null,
    rateLimits: session.rateLimits ?? null,
    agents: sessionDir ? listAgents(sessionDir, { parentTranscript: transcriptPath, now }) : [],
    workflows: sessionDir ? listWorkflows(sessionDir) : [],
    skills: transcriptPath ? recentSkills(transcriptPath) : [],
    shells: transcriptPath
      ? inFlightBash(transcriptPath).map((b) => ({
          command: b.command,
          description: b.description,
          elapsedMs: b.ts ? now - b.ts : null,
        }))
      : [],
    failures: transcriptPath ? recentFailures(transcriptPath, { now, windowMs: 10 * 60_000 }) : [],
    lastActivityMs: (transcriptPath ? lastActivityTs(transcriptPath) : null) ?? session.updatedAt ?? null,
    startedAt: session.startedAt ?? null,
    transcriptPath,
  };
}

function renderAllView(sessions, { now, color, ascii, width }) {
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const icon = (s) => (!s.alive ? paint('38;5;196', ascii ? 'x' : '✖') : s.registryStatus === 'busy' ? paint('38;5;154', ascii ? '*' : '●') : paint('38;5;245', ascii ? 'o' : '○'));
  const lines = [`${sessions.length} session(s) · ${sessions.filter((s) => s.alive).length} alive`];
  for (const s of sessions) {
    const where = s.isWorktree ? `${ascii ? 'wt ' : '⎇'}${s.state?.worktreeName || basename(s.cwd || '')}` : s.branch || '';
    lines.push(
      `${icon(s)} ` +
        padEndDisplay(truncateDisplay(redact(s.name) || s.sessionId || 'session', 34, { ascii }), 36) +
        padEndDisplay(paint('0;36', truncateDisplay(where, 22, { ascii })), 24) +
        padEndDisplay(s.model?.name || '-', 10) +
        padEndDisplay(s.registryStatus || (s.alive ? 'alive' : 'gone'), 7) +
        paint('38;5;245', s.updatedAt ? `${formatAge(now - s.updatedAt)} ago` : '')
    );
  }
  return lines.map((l) => (displayWidth(l) > width ? truncateDisplay(l, width, { ascii }) : l)).join('\n');
}

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      all: { type: 'boolean', default: false },
      watch: { type: 'boolean', short: 'w', default: false },
      interval: { type: 'string', short: 'n' },
      json: { type: 'boolean', default: false },
      session: { type: 'string' },
      ascii: { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
      purge: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: false,
  });
  const cmd = positionals[0];
  const home = process.env.HOME || homedir();

  if (values.help || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'install' || cmd === 'update') return install({ home });
  if (cmd === 'verify') return verify({ home });
  if (cmd === 'rollback') return rollback({ home });
  if (cmd === 'uninstall') return uninstall({ home, purge: values.purge });
  if (cmd === 'doctor') return doctor({ home });

  const hudDir = process.env.CLAUDE_HUD_DIR || join(home, '.claude', 'hud');
  const config = loadConfig(hudDir, process.env);
  const color = !values['no-color'] && config.style.color !== false && process.env.NO_COLOR === undefined;
  const ascii = values.ascii || config.style.ascii;
  const width = Math.min(process.stdout.columns || Number(process.env.COLUMNS) || 100, 140);

  const renderOnce = () => {
    const now = Date.now();
    const sessions = collectSessions({ home, hudDir });
    if (values.all) return renderAllView(sessions, { now, color, ascii, width });
    const session = pickSession(sessions, {
      explicitId: values.session,
      envSessionId: process.env.CLAUDE_CODE_SESSION_ID,
      cwd: process.cwd(),
    });
    if (!session) {
      // --json consumers get valid JSON even when nothing is running
      if (values.json) return 'null';
      return 'No Claude sessions found on this machine.\n(Sessions appear here once Claude Code renders its statusline at least once.)';
    }
    const data = buildSessionData(session, { home, now });
    if (values.json) return JSON.stringify(data, null, 2);
    return renderSessionView(data, {
      width,
      color,
      ascii,
      now,
      sections: config.hud?.sections,
      layout: config.hud?.layout,
      gutter: config.hud?.gutter,
      rowGap: config.hud?.rowGap,
    });
  };

  if (values.watch) {
    const intervalMs = Math.max(1000, (Number(values.interval) || config.watchIntervalMs / 1000) * 1000);
    process.stdout.write('\x1b[?1049h');
    const cleanup = () => {
      process.stdout.write('\x1b[?1049l');
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    const tick = () => {
      try {
        process.stdout.write('\x1b[2J\x1b[H' + renderOnce() + '\n');
      } catch (e) {
        // never strand the terminal in the alternate screen
        process.stdout.write('\x1b[?1049l');
        process.stderr.write(`claude-console: ${e?.message ?? e}\n`);
        process.exit(1);
      }
    };
    tick();
    setInterval(tick, intervalMs);
    return null; // keep event loop alive
  }

  process.stdout.write(renderOnce() + '\n');
  return 0;
}

const code = main();
if (code !== null) process.exit(code);
