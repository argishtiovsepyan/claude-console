#!/usr/bin/env node
// Statusline entry: Claude Code pipes a JSON payload on stdin per render
// (debounced 300ms, killed at 5s) and renders every stdout line as a row
// under the input box. Default mode is 'hud': the FULL final-design session
// view (WHO/WHERE/LIMITS | AGENTS/WORKFLOWS/SHELLS) renders inside every
// Claude Code tab, relative to THAT tab's session. 'block' (two compact
// rows) and legacy 'line' remain available via config. This process must
// NEVER exit non-zero, never block, and stay fast. It also persists
// per-session state (atomic) so `claude-console` sees every session.

import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { parseStatus } from './lib/status.mjs';
import { renderStatusLines } from './lib/segments.mjs';
import { renderSessionView } from './lib/hud.mjs';
import { loadConfig } from './lib/config.mjs';
import { makeStore } from './lib/state.mjs';
import { gitInfo } from './lib/gitinfo.mjs';
import { activeCounts, listAgents, listWorkflows, inFlightBash, lastActivityTs, detectEffortOverride } from './lib/transcript.mjs';
import { countLiveDescendants } from './lib/procs.mjs';

function maybeGc(store, config, now) {
  const marker = join(store.baseDir, 'state', '.last-gc');
  try {
    if (now - statSync(marker).mtimeMs < config.staleness.gcEveryMs) return;
  } catch {
    // no marker yet
  }
  try {
    mkdirSync(join(store.baseDir, 'state'), { recursive: true });
    writeFileSync(marker, String(now));
    store.gcStale({ olderThanMs: config.staleness.gcAfterMs, now });
  } catch {
    // GC is best-effort
  }
}

function main() {
  const t0 = process.hrtime.bigint();
  const env = process.env;
  const hudDir = env.CLAUDE_HUD_DIR || join(homedir(), '.claude', 'hud');
  const config = loadConfig(hudDir, env);

  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    // no stdin — render empty
  }
  const status = parseStatus(input);

  const cols = Number(env.COLUMNS);
  const width = Number.isFinite(cols) && cols > 20 ? cols : config.fallbackWidth;

  const store = makeStore(hudDir);
  const now = Date.now();

  let prev = null;
  if (status.sessionId) {
    try {
      prev = JSON.parse(readFileSync(join(store.sessionsDir, `${status.sessionId}.json`), 'utf8'));
    } catch {
      // first render for this session
    }
  }

  // git: branch/worktree every render (cheap); dirty count TTL-cached
  let git = { branch: null, dirtyCount: null, isWorktree: false };
  if (status.cwd) {
    const cached = prev?.gitCache;
    if (cached && cached.cwd === status.cwd && now - (cached.ts || 0) < config.gitDirtyTtlMs) {
      git = cached.info;
    } else {
      git = gitInfo(status.cwd);
    }
  }

  const mode = config.statusline?.mode ?? 'hud';
  const sessionDir = status.transcriptPath ? status.transcriptPath.replace(/\.jsonl$/, '') : null;
  const counts = { agents: 0, workflows: 0, procs: 0 };
  let effortOverride = null;
  let output;

  if (mode === 'hud') {
    // the final design, rendered per tab from THIS session's own sources
    const agents = sessionDir
      ? listAgents(sessionDir, { parentTranscript: status.transcriptPath, now, maxParentBytes: 1536 * 1024 })
      : [];
    const workflows = sessionDir ? listWorkflows(sessionDir) : [];
    const shells = status.transcriptPath
      ? inFlightBash(status.transcriptPath, { maxBytes: 1024 * 1024 }).map((b) => ({
          command: b.command,
          description: b.description,
          elapsedMs: b.ts ? now - b.ts : null,
        }))
      : [];
    counts.agents = agents.filter((a) => a.state === 'running').length;
    counts.workflows = workflows.filter((w) => w.status === 'running').length;

    let registryStatus = null;
    try {
      registryStatus =
        JSON.parse(readFileSync(join(dirname(hudDir), 'sessions', `${process.ppid}.json`), 'utf8')).status ?? null;
    } catch {
      // registry entry unavailable — STATUS falls back to 'alive'
    }

    // Claude Code's payload reports the base level ('xhigh') even while
    // ultracode is active; the /effort confirmation recorded in the
    // transcript carries the real level. The record may be far back in a
    // long transcript, so: shallow tail scan every render, one deep scan on
    // the first render ever, cached in session state in between.
    effortOverride = status.transcriptPath ? detectEffortOverride(status.transcriptPath) : null;
    if (!effortOverride) {
      if (prev && 'effortOverride' in prev) effortOverride = prev.effortOverride;
      else if (status.transcriptPath) effortOverride = detectEffortOverride(status.transcriptPath, { maxBytes: 8 * 1024 * 1024 });
    }
    let effort = status.effort;
    if (effort === 'xhigh' && effortOverride === 'ultracode') effort = 'ultracode';

    const data = {
      sessionId: status.sessionId,
      name: status.sessionName,
      alive: true,
      registryStatus,
      pid: process.ppid,
      cwd: status.cwd,
      model: status.model,
      effort,
      branch: git.branch,
      dirtyCount: git.dirtyCount,
      isWorktree: Boolean(status.gitWorktree || git.isWorktree),
      worktreeName: status.gitWorktree || (git.isWorktree && status.cwd ? basename(status.cwd) : null),
      repo: status.repo,
      pr: status.pr,
      cost: status.cost,
      context: status.context,
      rateLimits: status.rateLimits,
      agents,
      workflows,
      shells,
      skills: [],
      failures: [],
      lastActivityMs: (status.transcriptPath ? lastActivityTs(status.transcriptPath, { maxBytes: 128 * 1024 }) : null) ?? now,
    };
    // width margin: Claude Code's statusline area is slightly narrower than
    // COLUMNS (UI padding); rendering to the exact edge risks wrapped rows,
    // which scrambles the column grid
    output = renderSessionView(data, {
      width: Math.max(60, width - 4),
      color: config.style.color !== false,
      ascii: config.style.ascii,
      now,
      sections: config.hud?.sections,
      layout: config.hud?.layout,
      gutter: config.hud?.gutter,
      rowGap: config.hud?.rowGap,
      leadGuard: true,
    });
  } else {
    if (config.sections.activity && sessionDir) {
      const c = activeCounts(sessionDir, { now });
      counts.agents = c.agents;
      counts.workflows = c.workflows;
    }
    output = renderStatusLines({ status, git, counts, width, config, now }).join('\n');
  }

  if (config.sections.activity && env.CLAUDE_HUD_NO_PS !== '1') {
    counts.procs = countLiveDescendants(process.ppid);
  }

  process.stdout.write(output + '\n');

  if (status.sessionId) {
    const renderMs = Number(process.hrtime.bigint() - t0) / 1e6;
    try {
      store.writeSession({
        sessionId: status.sessionId,
        sessionName: status.sessionName,
        claudePid: process.ppid,
        cwd: status.cwd,
        projectDir: status.projectDir,
        transcriptPath: status.transcriptPath,
        model: status.model,
        effort: status.effort,
        effortOverride,
        fastMode: status.fastMode,
        repo: status.repo,
        pr: status.pr,
        branch: git.branch,
        isWorktree: Boolean(status.gitWorktree || git.isWorktree),
        worktreeName: status.gitWorktree || null,
        dirtyCount: git.dirtyCount,
        gitCache: { cwd: status.cwd, ts: now, info: git },
        context: status.context,
        rateLimits: status.rateLimits,
        cost: status.cost,
        counts,
        columns: width,
        version: status.version,
        renderMs,
        updatedAt: now,
      });
      maybeGc(store, config, now);
    } catch {
      // state persistence must never break rendering
    }
  }
}

try {
  main();
} catch {
  // Absolute last resort: print nothing but never fail the render loop.
  try {
    process.stdout.write('\n');
  } catch {
    // stdout gone — nothing to do
  }
}
process.exit(0);
