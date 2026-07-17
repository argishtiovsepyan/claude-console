// Readers over Claude Code's on-disk transcript layout (verified against
// v2.1.206):
//   ~/.claude/projects/<slug>/<session>.jsonl                     main transcript
//   ~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl  + .meta.json
//   ~/.claude/projects/<slug>/<session>/subagents/workflows/wf_*/   workflow agents + journal.jsonl
//   ~/.claude/projects/<slug>/<session>/workflows/wf_*.json          workflow run records
// All readers tolerate missing files/dirs and never expose prompt bodies —
// only short descriptions, passed through redact().

import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { redact } from './redact.mjs';

export function slugForCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9-]/g, '-');
}


// Read up to maxBytes from the end of a JSONL file and parse complete lines.
// The first line of the window is dropped when the read starts mid-file
// (it is almost certainly torn).
export function readTailLines(path, maxBytes = 512 * 1024) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    let lines = buf.toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1);
    const out = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // torn last line while the session is writing — skip
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

// Scan the parent transcript tail for subagent launches and completions.
export function readParentAgentEvents(transcriptPath, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const launches = new Map(); // toolUseId -> {toolUseId, description, subagentType, model, agentId?, ts}
  const completedAgentIds = new Set();
  const completedToolUseIds = new Set();

  for (const rec of readTailLines(transcriptPath, maxBytes)) {
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;

    if (rec.type === 'assistant') {
      for (const block of content) {
        if (block?.type === 'tool_use' && AGENT_TOOL_NAMES.has(block.name)) {
          launches.set(block.id, {
            toolUseId: block.id,
            description: redact(block.input?.description ?? ''),
            subagentType: block.input?.subagent_type ?? null,
            model: block.input?.model ?? null,
            agentId: null,
            ts,
          });
        }
      }
    } else if (rec.type === 'user') {
      const agentBlocks = content.filter((b) => b?.type === 'tool_result' && launches.has(b.tool_use_id));
      // rec.toolUseResult is RECORD-level: with more than one agent tool_result
      // in the same turn it belongs to only one of them, and applying it to all
      // would cross-stamp agentIds and completion states. In the ambiguous case
      // we stamp nothing — liveness falls back to file activity, which is
      // honest rather than wrong.
      const result = agentBlocks.length === 1 ? rec.toolUseResult : null;
      if (agentBlocks.length > 1) continue;
      for (const block of agentBlocks) {
        const launch = launches.get(block.tool_use_id);
        const agentId = result?.agentId ?? null;
        if (agentId) launch.agentId = agentId;
        if (result?.status === 'async_launched') continue; // still running
        completedToolUseIds.add(block.tool_use_id);
        if (agentId) completedAgentIds.add(agentId);
      }
    }
  }
  return { launches, completedAgentIds, completedToolUseIds };
}

// Short display name for a model id: 'claude-sonnet-5' → 'sonnet'.
export function shortModelName(id) {
  if (!id || typeof id !== 'string') return null;
  const m = /(fable|opus|sonnet|haiku)/i.exec(id);
  return m ? m[1].toLowerCase() : id.slice(0, 12);
}

// The model an agent ACTUALLY ran as: its own transcript's assistant records
// carry message.model from the API response. Newest record wins.
function modelFromAgentTranscript(path, maxBytes = 64 * 1024) {
  const recs = readTailLines(path, maxBytes);
  for (let i = recs.length - 1; i >= 0; i--) {
    const rec = recs[i];
    if (rec?.type === 'assistant' && typeof rec.message?.model === 'string') return rec.message.model;
  }
  return null;
}

// An agent waiting on a long tool call writes nothing, so its file goes
// quiet — but an unresolved tool_use in its tail means it is mid-call and
// very much running.
function hasOpenToolUse(path, maxBytes = 64 * 1024) {
  const openIds = new Set();
  for (const rec of readTailLines(path, maxBytes)) {
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    if (rec.type === 'assistant') {
      for (const b of content) if (b?.type === 'tool_use') openIds.add(b.id);
    } else if (rec.type === 'user') {
      for (const b of content) if (b?.type === 'tool_result') openIds.delete(b.tool_use_id);
    }
  }
  return openIds.size > 0;
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function agentFilesIn(dir, isWorkflowAgent, wfRunId = null) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const m = /^agent-(.+)\.jsonl$/.exec(f);
    if (!m) continue;
    const path = join(dir, f);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    const meta = readJsonSafe(join(dir, `agent-${m[1]}.meta.json`));
    out.push({ agentId: m[1], path, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, meta, isWorkflowAgent, wfRunId });
  }
  return out;
}

export function listAgents(
  sessionDir,
  { parentTranscript = null, now = Date.now(), activeWithinMs = 45_000, maxParentBytes = 2 * 1024 * 1024 } = {}
) {
  const subagents = join(sessionDir, 'subagents');
  const entries = agentFilesIn(subagents, false);
  const wfRoot = join(subagents, 'workflows');
  try {
    for (const wf of readdirSync(wfRoot)) {
      entries.push(...agentFilesIn(join(wfRoot, wf), true, wf));
    }
  } catch {
    // no workflows dir
  }

  const events = parentTranscript
    ? readParentAgentEvents(parentTranscript, { maxBytes: maxParentBytes })
    : { launches: new Map(), completedAgentIds: new Set(), completedToolUseIds: new Set() };
  const launchByAgentId = new Map();
  for (const l of events.launches.values()) if (l.agentId) launchByAgentId.set(l.agentId, l);

  let tailReads = 0; // bound the hot path: at most a few small tail reads per render
  return entries
    .map((e) => {
      const toolUseId = e.meta?.toolUseId ?? null;
      const launch = launchByAgentId.get(e.agentId) ?? (toolUseId ? events.launches.get(toolUseId) : null);
      const completed =
        events.completedAgentIds.has(e.agentId) || (toolUseId && events.completedToolUseIds.has(toolUseId));
      let state;
      if (completed) state = 'done';
      else if (launch || now - e.mtimeMs <= activeWithinMs) state = 'running';
      else state = 'idle';
      // quiet ≠ done: a stale-looking agent whose tail holds an unresolved
      // tool_use is waiting on that call (long test run, timer) — running.
      // Bounded reads keep the statusline hot path sub-second.
      if (state === 'idle' && now - e.mtimeMs <= 2 * 3600_000 && tailReads < 12) {
        tailReads++;
        if (hasOpenToolUse(e.path)) state = 'running';
      }
      // meta records what actually ran; the agent's own transcript is the
      // API's word (covers workflow agents, whose meta is bare); the launch
      // input is only the REQUESTED model and can be overridden at spawn
      let model = e.meta?.model ?? null;
      if (!model && state === 'running' && tailReads < 12) {
        tailReads++;
        model = modelFromAgentTranscript(e.path);
      }
      if (!model) model = launch?.model ?? null;
      return {
        agentId: e.agentId,
        agentType: e.meta?.agentType ?? launch?.subagentType ?? null,
        description: redact(e.meta?.description ?? launch?.description ?? '') || null,
        model: shortModelName(model),
        state,
        isWorkflowAgent: e.isWorkflowAgent,
        wfRunId: e.wfRunId,
        lastActivityMs: e.mtimeMs,
        startedMs: e.birthtimeMs || null,
      };
    })
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

export function listWorkflows(sessionDir, { now = Date.now(), activeWithinMs = 45_000 } = {}) {
  const dir = join(sessionDir, 'workflows');
  const out = [];
  const seen = new Set();
  let files = [];
  try {
    files = readdirSync(dir);
  } catch {
    // no completed runs yet — live ones may still be synthesized below
  }
  for (const f of files) {
    if (!/^wf_.+\.json$/.test(f)) continue;
    const wf = readJsonSafe(join(dir, f));
    if (!wf) continue;
    const runId = wf.runId ?? basename(f, '.json');
    seen.add(runId);
    const prog = wf.workflowProgress;
    out.push({
      runId,
      workflowName: wf.workflowName ?? null,
      status: wf.status ?? null,
      agentCount: wf.agentCount ?? null,
      progress:
        prog && typeof prog === 'object'
          ? { done: prog.done ?? prog.completed ?? null, total: prog.total ?? null }
          : null,
      startTime: wf.startTime ?? null,
      durationMs: wf.durationMs ?? null,
    });
  }
  // a run record is only written when the workflow ENDS — while it runs, the
  // only disk truth is its agent dir. A fresh journal/agent file there means
  // a live run: synthesize a running entry with journal-derived progress.
  const wfRoot = join(sessionDir, 'subagents', 'workflows');
  let liveDirs = [];
  try {
    liveDirs = readdirSync(wfRoot);
  } catch {
    // no workflow agent dirs
  }
  for (const wf of liveDirs) {
    if (seen.has(wf)) continue;
    const wfDir = join(wfRoot, wf);
    let newest = 0;
    let birth = null;
    try {
      for (const f of readdirSync(wfDir)) {
        if (f !== 'journal.jsonl' && !/^agent-.+\.jsonl$/.test(f)) continue;
        const st = statSync(join(wfDir, f));
        newest = Math.max(newest, st.mtimeMs);
        if (f === 'journal.jsonl') birth = st.birthtimeMs || null;
      }
    } catch {
      continue;
    }
    if (!newest || now - newest > activeWithinMs) continue;
    let started = 0;
    let done = 0;
    for (const rec of readTailLines(join(wfDir, 'journal.jsonl'), 256 * 1024)) {
      if (rec?.type === 'started') started++;
      else if (rec?.type === 'result') done++;
    }
    // the run's NAME only reaches the record at completion, but the launcher
    // writes the script as workflows/scripts/<name>-<runId>.js at start
    let name = null;
    try {
      for (const f of readdirSync(join(dir, 'scripts'))) {
        if (f.endsWith(`-${wf}.js`)) {
          name = f.slice(0, -(wf.length + 4));
          break;
        }
      }
    } catch {
      // no scripts dir — keep the runId as the display name
    }
    out.push({
      runId: wf,
      workflowName: name,
      status: 'running',
      agentCount: started || null,
      progress: started ? { done, total: started } : null,
      startTime: birth,
      durationMs: null,
    });
  }
  return out.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}

function flattenResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : ''))
      .join(' ');
  }
  return '';
}

export function recentFailures(transcriptPath, { now = Date.now(), windowMs = 3600_000, maxBytes = 1024 * 1024 } = {}) {
  const toolNames = new Map();
  const failures = [];
  for (const rec of readTailLines(transcriptPath, maxBytes)) {
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
    if (rec.type === 'assistant') {
      for (const b of content) if (b?.type === 'tool_use') toolNames.set(b.id, b.name);
    } else if (rec.type === 'user') {
      for (const b of content) {
        if (b?.type !== 'tool_result' || b.is_error !== true) continue;
        if (ts !== null && now - ts > windowMs) continue;
        failures.push({
          ts,
          tool: toolNames.get(b.tool_use_id) ?? 'unknown',
          snippet: redact(flattenResultContent(b.content).slice(0, 400)).slice(0, 160),
        });
      }
    }
  }
  return failures;
}

// Skill tool invocations (what skills/slash-commands this session has used).
export function recentSkills(transcriptPath, { maxBytes = 1024 * 1024 } = {}) {
  const latest = new Map(); // skill name -> ts
  for (const rec of readTailLines(transcriptPath, maxBytes)) {
    if (rec?.type !== 'assistant') continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
    for (const b of content) {
      if (b?.type === 'tool_use' && b.name === 'Skill' && typeof b.input?.skill === 'string') {
        const name = redact(b.input.skill.slice(0, 120)); // redact at source: covers --json too
        latest.set(name, ts ?? latest.get(name) ?? 0);
      }
    }
  }
  return [...latest.entries()]
    .map(([skill, ts]) => ({ skill, ts }))
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}

// Bash commands running right now, each with the human description Claude
// attached to the call. Foreground commands are open until their tool_result;
// background commands (run_in_background) ack with an immediate tool_result,
// so they stay open until the task-notification naming their tool-use-id.
export function inFlightBash(transcriptPath, { maxBytes = 1024 * 1024 } = {}) {
  const open = new Map(); // tool_use id -> {command, description, ts, background}
  for (const rec of readTailLines(transcriptPath, maxBytes)) {
    // finished background tasks announce as queue-operation records whose
    // top-level content string names the launching tool-use-id
    const raw = typeof rec?.content === 'string' ? rec.content : '';
    if (raw.includes('<task-notification>')) {
      for (const m of raw.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) open.delete(m[1]);
    }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    if (rec.type === 'assistant') {
      const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
      for (const b of content) {
        if (b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') {
          // cap BEFORE redacting: an in-flight heredoc can be hundreds of KB
          // and must never stall a render
          open.set(b.id, {
            command: redact(b.input.command.slice(0, 300)),
            description: redact(String(b.input.description ?? '').slice(0, 200)) || null,
            ts,
            background: b.input.run_in_background === true,
          });
        }
      }
    } else if (rec.type === 'user') {
      for (const b of content) {
        if (b?.type === 'tool_result' && open.get(b.tool_use_id)?.background !== true) open.delete(b.tool_use_id);
        // task-notifications are text blocks naming the finished tool-use-id
        const text = b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
        if (text.includes('<task-notification>')) {
          for (const m of text.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) open.delete(m[1]);
        }
      }
    }
  }
  return [...open.values()].map(({ background, ...sh }) => sh).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

// The /effort command's confirmation is recorded verbatim in the transcript
// (a USER record whose content contains "<local-command-stdout>Set effort
// level to X"). The statusline stdin keeps reporting the base level (e.g.
// 'xhigh' while ultracode is active), so this record is the only on-disk
// source of the real session effort. Only genuine user records with plain
// text content count — assistant records (thinking, tool inputs) and
// tool_result blocks are excluded so a session that merely DISCUSSES this
// feature can't poison the detection. Last occurrence wins.
export function detectEffortOverride(transcriptPath, { maxBytes = 256 * 1024 } = {}) {
  let level = null;
  for (const rec of readTailLines(transcriptPath, maxBytes)) {
    if (rec?.type !== 'user') continue;
    const content = rec.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join(' ')
          : '';
    for (const m of text.matchAll(/<local-command-stdout>Set effort level to (\w+)/g)) level = m[1];
  }
  return level;
}

export function lastActivityTs(transcriptPath, { maxBytes = 256 * 1024 } = {}) {
  const lines = readTailLines(transcriptPath, maxBytes);
  for (let i = lines.length - 1; i >= 0; i--) {
    const ts = lines[i]?.timestamp ? Date.parse(lines[i].timestamp) : NaN;
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

// Hot-path counts for the compact statusline: one readdir pass, no JSON parsing.
export function activeCounts(sessionDir, { now = Date.now(), activeWithinMs = 45_000 } = {}) {
  let agents = 0;
  let workflows = 0;
  const subagents = join(sessionDir, 'subagents');
  const fresh = (p) => {
    try {
      return now - statSync(p).mtimeMs <= activeWithinMs;
    } catch {
      return false;
    }
  };
  try {
    for (const f of readdirSync(subagents)) {
      if (/^agent-.+\.jsonl$/.test(f) && fresh(join(subagents, f))) agents++;
    }
  } catch {
    return { agents: 0, workflows: 0 };
  }
  const wfRoot = join(subagents, 'workflows');
  try {
    for (const wf of readdirSync(wfRoot)) {
      const wfDir = join(wfRoot, wf);
      let wfActive = false;
      try {
        for (const f of readdirSync(wfDir)) {
          if (/^agent-.+\.jsonl$/.test(f) && fresh(join(wfDir, f))) agents++;
          if (f === 'journal.jsonl' && fresh(join(wfDir, f))) wfActive = true;
        }
      } catch {
        continue;
      }
      if (wfActive) workflows++;
    }
  } catch {
    // no workflow agents
  }
  return { agents, workflows };
}
