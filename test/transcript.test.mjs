import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  slugForCwd,
  readTailLines,
  readParentAgentEvents,
  listAgents,
  listWorkflows,
  recentFailures,
  recentSkills,
  inFlightBash,
  lastActivityTs,
  activeCounts,
  detectEffortOverride,
  shortModelName,
} from '../src/lib/transcript.mjs';

// ---------- slug encoding (verified against real ~/.claude/projects layout) ----------

test('slugForCwd matches the observed worktree slug encoding', () => {
  assert.equal(
    slugForCwd('/Users/dev/code/my-repo/.claude/worktrees/drain-command'),
    '-Users-dev-code-my-repo--claude-worktrees-drain-command'
  );
  assert.equal(slugForCwd('/Users/dev/code/my-repo'), '-Users-dev-code-my-repo');
});

// ---------- fixture session ----------

const T0 = Date.parse('2026-07-16T18:00:00Z');
const iso = (offsetSec) => new Date(T0 + offsetSec * 1000).toISOString();
const mkdirSyncTemp = () => mkdtempSync(join(tmpdir(), 'hud-batched-'));

function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hud-transcript-'));
  const sessionId = 'aaaaaaaa-1111-2222-3333-444444444444';
  const transcript = join(dir, `${sessionId}.jsonl`);
  const sessionDir = join(dir, sessionId);
  const subagents = join(sessionDir, 'subagents');
  const wfAgents = join(subagents, 'workflows', 'wf_abc12345-def');
  const workflows = join(sessionDir, 'workflows');
  mkdirSync(wfAgents, { recursive: true });
  mkdirSync(workflows, { recursive: true });

  const lines = [
    // agent launch (tool_use) + async_launched result
    {
      type: 'assistant',
      timestamp: iso(10),
      message: {
        role: 'assistant',
        model: 'claude-fable-5',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_AG1',
            name: 'Agent',
            input: { description: 'recon docs', prompt: 'long prompt SECRET token=zq9xsecret', subagent_type: 'general-purpose', model: 'sonnet' },
          },
        ],
        usage: { input_tokens: 5, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 },
      },
    },
    {
      type: 'user',
      timestamp: iso(11),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_AG1' }] },
      toolUseResult: { status: 'async_launched', agentId: 'a1', description: 'recon docs', isAsync: true, resolvedModel: 'claude-sonnet-5' },
    },
    // a Bash tool that failed
    {
      type: 'assistant',
      timestamp: iso(20),
      message: {
        role: 'assistant',
        model: 'claude-fable-5',
        content: [{ type: 'tool_use', id: 'toolu_B1', name: 'Bash', input: { command: 'npm run build' } }],
        usage: { input_tokens: 5, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 1200 },
      },
    },
    {
      type: 'user',
      timestamp: iso(25),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_B1', is_error: true, content: 'Command failed: npm run build\nTS2304 password=hunter2' }],
      },
      toolUseResult: { stdout: '', stderr: 'TS2304', interrupted: false },
    },
    // second agent, completed
    {
      type: 'assistant',
      timestamp: iso(30),
      message: {
        role: 'assistant',
        model: 'claude-fable-5',
        content: [
          { type: 'tool_use', id: 'toolu_AG2', name: 'Agent', input: { description: 'quick check', prompt: 'x', subagent_type: 'Explore' } },
        ],
        usage: { input_tokens: 5, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 1400 },
      },
    },
    {
      type: 'user',
      timestamp: iso(40),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_AG2' }] },
      toolUseResult: { status: 'completed', agentId: 'a2', description: 'quick check' },
    },
    // an in-flight Bash command (no tool_result yet) with its description
    {
      type: 'assistant',
      timestamp: iso(33),
      message: {
        role: 'assistant',
        model: 'claude-fable-5',
        content: [
          { type: 'tool_use', id: 'toolu_B2', name: 'Bash', input: { command: 'npm run e2e -- --token=shh123', description: 'Run e2e suite' } },
        ],
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 },
      },
    },
    // skill invocations
    {
      type: 'assistant',
      timestamp: iso(35),
      message: {
        role: 'assistant',
        model: 'claude-fable-5',
        content: [{ type: 'tool_use', id: 'toolu_SK1', name: 'Skill', input: { skill: 'superpowers:test-driven-development' } }],
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 },
      },
    },
    {
      type: 'assistant',
      timestamp: iso(38),
      message: {
        role: 'assistant',
        model: 'claude-fable-5',
        content: [{ type: 'tool_use', id: 'toolu_SK2', name: 'Skill', input: { skill: 'artifact-design' } }],
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 },
      },
    },
    // trailer without timestamp (must not count as activity)
    { type: 'ai-title', title: 'whatever' },
  ];
  writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // subagent transcripts + meta
  writeFileSync(join(subagents, 'agent-a1.jsonl'), JSON.stringify({ type: 'user', timestamp: iso(12) }) + '\n');
  writeFileSync(
    join(subagents, 'agent-a1.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'recon docs', spawnDepth: 1, toolUseId: 'toolu_AG1' })
  );
  writeFileSync(join(subagents, 'agent-a2.jsonl'), JSON.stringify({ type: 'user', timestamp: iso(31) }) + '\n');
  writeFileSync(
    join(subagents, 'agent-a2.meta.json'),
    JSON.stringify({ agentType: 'Explore', description: 'quick check', spawnDepth: 1, toolUseId: 'toolu_AG2' })
  );
  // workflow agent + journal + run record
  writeFileSync(join(wfAgents, 'agent-w1.jsonl'), JSON.stringify({ type: 'user', timestamp: iso(35) }) + '\n');
  writeFileSync(join(wfAgents, 'agent-w1.meta.json'), JSON.stringify({ agentType: 'workflow-subagent' }));
  writeFileSync(join(wfAgents, 'journal.jsonl'), JSON.stringify({ type: 'result', label: 'recon:x' }) + '\n');
  writeFileSync(
    join(workflows, 'wf_abc12345-def.json'),
    JSON.stringify({
      runId: 'wf_abc12345-def',
      workflowName: 'hud-discovery',
      status: 'running',
      agentCount: 5,
      workflowProgress: { done: 3, total: 5 },
      startTime: T0,
    })
  );
  return { dir, sessionId, transcript, sessionDir, subagents, wfAgents };
}

test('readTailLines drops a torn first line and parses the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hud-tail-'));
  const p = join(dir, 't.jsonl');
  const rows = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(100) }));
  writeFileSync(p, rows.join('\n') + '\n');
  const out = readTailLines(p, 1000); // lands mid-line
  assert.ok(out.length > 0);
  assert.ok(out.every((o) => typeof o.i === 'number'));
  assert.equal(out[out.length - 1].i, 49);
});

test('readParentAgentEvents links launches and completions', () => {
  const { transcript } = buildFixture();
  const ev = readParentAgentEvents(transcript);
  assert.equal(ev.launches.get('toolu_AG1').description, 'recon docs');
  assert.equal(ev.launches.get('toolu_AG1').subagentType, 'general-purpose');
  assert.equal(ev.launches.get('toolu_AG1').agentId, 'a1');
  assert.equal(ev.completedAgentIds.has('a1'), false); // async_launched, not completed
  assert.equal(ev.completedAgentIds.has('a2'), true);
});

test('batched multi-agent completions never cross-stamp agent ids (regression)', () => {
  const dir = mkdirSyncTemp();
  const t = join(dir, 'batched.jsonl');
  const lines = [
    {
      type: 'assistant',
      timestamp: iso(1),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_X', name: 'Agent', input: { description: 'agent A task', subagent_type: 'x', model: 'opus' } },
          { type: 'tool_use', id: 'toolu_Y', name: 'Agent', input: { description: 'agent B task', subagent_type: 'y', model: 'sonnet' } },
        ],
      },
    },
    // ONE user record carrying BOTH tool_results, with a single record-level
    // toolUseResult that belongs to only one of them — ambiguous.
    {
      type: 'user',
      timestamp: iso(2),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_X' },
          { type: 'tool_result', tool_use_id: 'toolu_Y' },
        ],
      },
      toolUseResult: { status: 'completed', agentId: 'ax' },
    },
  ];
  writeFileSync(t, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const ev = readParentAgentEvents(t);
  // per-tool_use launch data stays correct
  assert.equal(ev.launches.get('toolu_X').model, 'opus');
  assert.equal(ev.launches.get('toolu_Y').model, 'sonnet');
  // the ambiguous record-level agentId must not be stamped onto either launch
  assert.equal(ev.launches.get('toolu_X').agentId, null);
  assert.equal(ev.launches.get('toolu_Y').agentId, null);
  // and nothing may be claimed completed from an ambiguous record
  assert.equal(ev.completedAgentIds.size, 0);
  assert.equal(ev.completedToolUseIds.size, 0);
});

test('listAgents merges meta, parent events and liveness', () => {
  const { sessionDir, transcript } = buildFixture();
  const now = Date.now();
  const agents = listAgents(sessionDir, { parentTranscript: transcript, now });
  const byId = Object.fromEntries(agents.map((a) => [a.agentId, a]));
  assert.equal(byId.a1.description, 'recon docs');
  assert.equal(byId.a1.agentType, 'general-purpose');
  assert.equal(byId.a1.state, 'running'); // launched async, no completion record
  assert.equal(byId.a2.state, 'done');
  assert.equal(byId.w1.isWorkflowAgent, true);
});

test('shortModelName maps ids to display families', () => {
  assert.equal(shortModelName('claude-fable-5'), 'fable');
  assert.equal(shortModelName('claude-opus-4-8'), 'opus');
  assert.equal(shortModelName('claude-sonnet-5'), 'sonnet');
  assert.equal(shortModelName('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(shortModelName('sonnet'), 'sonnet');
  assert.equal(shortModelName(null), null);
});

test('listAgents model: meta first, then the agent transcript, then the launch input', () => {
  const dir = mkdirSyncTemp();
  const sessionDir = join(dir, 'sess');
  const subagents = join(sessionDir, 'subagents');
  const wfAgents = join(subagents, 'workflows', 'wf_model11-abc');
  mkdirSync(wfAgents, { recursive: true });
  const transcript = join(dir, 'parent.jsonl');
  writeFileSync(
    transcript,
    [
      {
        type: 'assistant',
        timestamp: iso(1),
        message: {
          role: 'assistant',
          content: [
            // requested haiku, but the meta records what actually ran — meta must win
            { type: 'tool_use', id: 'toolu_MM1', name: 'Agent', input: { description: 'meta wins', model: 'haiku' } },
            { type: 'tool_use', id: 'toolu_MM3', name: 'Agent', input: { description: 'launch fallback', model: 'opus' } },
          ],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  );
  // meta carries the model (spawned-agent case)
  writeFileSync(join(subagents, 'agent-ma.jsonl'), JSON.stringify({ type: 'user', timestamp: iso(2) }) + '\n');
  writeFileSync(
    join(subagents, 'agent-ma.meta.json'),
    JSON.stringify({ agentType: 'x', description: 'meta wins', toolUseId: 'toolu_MM1', model: 'claude-sonnet-5' })
  );
  // workflow agent: bare meta, model only in its own transcript records
  writeFileSync(
    join(wfAgents, 'agent-mw.jsonl'),
    [
      JSON.stringify({ type: 'user', timestamp: iso(2) }),
      JSON.stringify({ type: 'assistant', timestamp: iso(3), message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [] } }),
    ].join('\n') + '\n'
  );
  writeFileSync(join(wfAgents, 'agent-mw.meta.json'), JSON.stringify({ agentType: 'workflow-subagent' }));
  // no meta model, empty own transcript → launch input is the last resort
  writeFileSync(join(subagents, 'agent-mf.jsonl'), JSON.stringify({ type: 'user', timestamp: iso(2) }) + '\n');
  writeFileSync(
    join(subagents, 'agent-mf.meta.json'),
    JSON.stringify({ agentType: 'x', description: 'launch fallback', toolUseId: 'toolu_MM3' })
  );
  const agents = listAgents(sessionDir, { parentTranscript: transcript, now: Date.now() });
  const byId = Object.fromEntries(agents.map((a) => [a.agentId, a]));
  assert.equal(byId.ma.model, 'sonnet', 'meta model must win over the launch input');
  assert.equal(byId.mw.model, 'haiku', 'workflow agents read their own transcript');
  assert.equal(byId.mf.model, 'opus', 'launch input is the fallback');
});

test('inFlightBash keeps background commands open until their task-notification arrives', () => {
  const dir = mkdirSyncTemp();
  const t = join(dir, 'bg.jsonl');
  const lines = [
    {
      type: 'assistant',
      timestamp: iso(1),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_BG1', name: 'Bash', input: { command: 'sleep 300', description: 'Watch API test suite', run_in_background: true } },
          { type: 'tool_use', id: 'toolu_BG2', name: 'Bash', input: { command: 'sleep 330', description: 'Tail dev server logs', run_in_background: true } },
        ],
      },
    },
    // background launches ack immediately with a tool_result — must stay open
    {
      type: 'user',
      timestamp: iso(2),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_BG1', content: 'Command running in background with ID: b111' },
          { type: 'tool_result', tool_use_id: 'toolu_BG2', content: 'Command running in background with ID: b222' },
        ],
      },
    },
    // the first one finishes: its task-notification is a queue-operation
    // record whose top-level content string names the tool-use-id
    {
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: iso(3),
      content: '<task-notification>\n<task-id>b111</task-id>\n<tool-use-id>toolu_BG1</tool-use-id>\n<status>completed</status>\n<summary>Background command "Watch API test suite" completed (exit code 0)</summary>\n</task-notification>',
    },
  ];
  writeFileSync(t, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const open = inFlightBash(t);
  assert.equal(open.length, 1, JSON.stringify(open));
  assert.equal(open[0].description, 'Tail dev server logs');
});

test('listWorkflows synthesizes a running entry from a fresh journal when no record exists yet', () => {
  const dir = mkdirSyncTemp();
  const sessionDir = join(dir, 'sess');
  const liveDir = join(sessionDir, 'subagents', 'workflows', 'wf_live0001-abc');
  const staleDir = join(sessionDir, 'subagents', 'workflows', 'wf_old00001-xyz');
  mkdirSync(liveDir, { recursive: true });
  mkdirSync(staleDir, { recursive: true });
  mkdirSync(join(sessionDir, 'workflows'), { recursive: true });
  const journal = [
    { type: 'started', key: 'k1', agentId: 'a1' },
    { type: 'started', key: 'k2', agentId: 'a2' },
    { type: 'started', key: 'k3', agentId: 'a3' },
    { type: 'result', key: 'k1', agentId: 'a1', result: 'done' },
  ];
  writeFileSync(join(liveDir, 'journal.jsonl'), journal.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(staleDir, 'journal.jsonl'), JSON.stringify(journal[0]) + '\n');
  const old = (Date.now() - 3600_000) / 1000;
  utimesSync(join(staleDir, 'journal.jsonl'), old, old);
  // the launcher writes the script as <workflowName>-<runId>.js at start —
  // the only on-disk source of the name while the run is live
  const scriptsDir = join(sessionDir, 'workflows', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, 'hud-demo-beta-wf_live0001-abc.js'), 'export const meta = {}\n');
  const wfs = listWorkflows(sessionDir, { now: Date.now() });
  assert.equal(wfs.length, 1, JSON.stringify(wfs));
  assert.equal(wfs[0].runId, 'wf_live0001-abc');
  assert.equal(wfs[0].workflowName, 'hud-demo-beta');
  assert.equal(wfs[0].status, 'running');
  assert.deepEqual(wfs[0].progress, { done: 1, total: 3 });
});

test('listWorkflows does not duplicate a run that already has its record', () => {
  const { sessionDir, wfAgents } = buildFixture();
  // make the fixture workflow's journal look freshly active
  writeFileSync(join(wfAgents, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'k', agentId: 'w1' }) + '\n');
  const wfs = listWorkflows(sessionDir, { now: Date.now() });
  const ids = wfs.map((w) => w.runId);
  assert.equal(ids.filter((id) => id === 'wf_abc12345-def').length, 1, JSON.stringify(ids));
});

test('listAgents: a quiet agent mid-tool-call (open tool_use) still counts as running', () => {
  const dir = mkdirSyncTemp();
  const sessionDir = join(dir, 'sess');
  const subagents = join(sessionDir, 'subagents');
  mkdirSync(subagents, { recursive: true });
  const old = (Date.now() - 10 * 60_000) / 1000;
  // waiting on a long Bash call: last record is a tool_use with no result
  writeFileSync(
    join(subagents, 'agent-busy1.jsonl'),
    [
      JSON.stringify({ type: 'assistant', timestamp: iso(1), message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 'toolu_T1', name: 'Bash', input: { command: 'node -e "setTimeout(()=>{},400000)"' } }] } }),
    ].join('\n') + '\n'
  );
  writeFileSync(join(subagents, 'agent-busy1.meta.json'), JSON.stringify({ agentType: 'x', description: 'long timer' }));
  utimesSync(join(subagents, 'agent-busy1.jsonl'), old, old);
  // genuinely idle: its last tool call already resolved
  writeFileSync(
    join(subagents, 'agent-idle1.jsonl'),
    [
      JSON.stringify({ type: 'assistant', timestamp: iso(1), message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 'toolu_T2', name: 'Bash', input: { command: 'ls' } }] } }),
      JSON.stringify({ type: 'user', timestamp: iso(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_T2' }] } }),
    ].join('\n') + '\n'
  );
  writeFileSync(join(subagents, 'agent-idle1.meta.json'), JSON.stringify({ agentType: 'x', description: 'finished tool' }));
  utimesSync(join(subagents, 'agent-idle1.jsonl'), old, old);
  const agents = listAgents(sessionDir, { now: Date.now() });
  const byId = Object.fromEntries(agents.map((a) => [a.agentId, a]));
  assert.equal(byId.busy1.state, 'running', JSON.stringify(byId.busy1));
  assert.equal(byId.idle1.state, 'idle', JSON.stringify(byId.idle1));
});

test('listAgents never exposes the agent prompt', () => {
  const { sessionDir, transcript } = buildFixture();
  const agents = listAgents(sessionDir, { parentTranscript: transcript, now: Date.now() });
  const dump = JSON.stringify(agents);
  assert.ok(!dump.includes('SECRET'), dump);
  assert.ok(!dump.includes('zq9xsecret'), dump);
});

test('listWorkflows reads run records with progress', () => {
  const { sessionDir } = buildFixture();
  const wfs = listWorkflows(sessionDir);
  assert.equal(wfs.length, 1);
  assert.equal(wfs[0].workflowName, 'hud-discovery');
  assert.equal(wfs[0].status, 'running');
  assert.deepEqual(wfs[0].progress, { done: 3, total: 5 });
});

test('recentFailures reports redacted failure snippets with tool names', () => {
  const { transcript } = buildFixture();
  const fails = recentFailures(transcript, { now: T0 + 60_000, windowMs: 3600_000 });
  assert.equal(fails.length, 1);
  assert.equal(fails[0].tool, 'Bash');
  assert.ok(fails[0].snippet.includes('Command failed'));
  assert.ok(!fails[0].snippet.includes('hunter2'), fails[0].snippet);
});

test('lastActivityTs uses the last timestamped record, ignoring trailers', () => {
  const { transcript } = buildFixture();
  assert.equal(lastActivityTs(transcript), T0 + 38_000);
});

test('inFlightBash caps huge command bodies before redaction (hang guard)', () => {
  const dir = mkdirSyncTemp();
  const t = join(dir, 'huge.jsonl');
  const hugeCommand = 'a1b2c3d4e5f6g7h8i9j0'.repeat(20000); // 400k chars of dense alnum
  writeFileSync(
    t,
    JSON.stringify({
      type: 'assistant',
      timestamp: iso(1),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: hugeCommand, description: 'big heredoc' } }],
      },
    }) + '\n'
  );
  const t0 = Date.now();
  const inflight = inFlightBash(t);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `inFlightBash took ${ms}ms`);
  assert.ok(inflight[0].command.length <= 400, `command not capped: ${inflight[0].command.length}`);
});

test('recentSkills redacts at the source (covers --json path)', () => {
  const dir = mkdirSyncTemp();
  const t = join(dir, 'skills.jsonl');
  writeFileSync(
    t,
    JSON.stringify({
      type: 'assistant',
      timestamp: iso(1),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'deploy token=supersecret9x' } }],
      },
    }) + '\n'
  );
  const skills = recentSkills(t);
  assert.ok(!JSON.stringify(skills).includes('supersecret9x'), JSON.stringify(skills));
});

test('inFlightBash returns running commands with purpose, redacted', () => {
  const { transcript } = buildFixture();
  const inflight = inFlightBash(transcript);
  assert.equal(inflight.length, 1);
  assert.equal(inflight[0].description, 'Run e2e suite');
  assert.ok(!inflight[0].command.includes('shh123'), inflight[0].command);
  assert.ok(inflight[0].command.includes('npm run e2e'), inflight[0].command);
  assert.equal(inflight[0].ts, T0 + 33_000);
});

test('detectEffortOverride reads the real /effort level from the transcript', () => {
  const dir = mkdirSyncTemp();
  const t = join(dir, 'effort.jsonl');
  writeFileSync(
    t,
    [
      JSON.stringify({ type: 'user', timestamp: iso(1), message: { role: 'user', content: '<local-command-stdout>Set effort level to max (this session only)</local-command-stdout>' } }),
      JSON.stringify({ type: 'user', timestamp: iso(2), message: { role: 'user', content: '<local-command-stdout>Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration</local-command-stdout>' } }),
      // an assistant merely MENTIONING the phrase must not count
      JSON.stringify({ type: 'assistant', timestamp: iso(3), message: { role: 'assistant', content: [{ type: 'text', text: 'the line Set effort level to low is just prose' }] } }),
    ].join('\n') + '\n'
  );
  assert.equal(detectEffortOverride(t), 'ultracode');
});

test('detectEffortOverride returns null when no /effort record exists', () => {
  const { transcript } = buildFixture();
  assert.equal(detectEffortOverride(transcript), null);
});

test('recentSkills lists distinct skills, most recent first', () => {
  const { transcript } = buildFixture();
  const skills = recentSkills(transcript);
  assert.deepEqual(skills.map((s) => s.skill), ['artifact-design', 'superpowers:test-driven-development']);
  assert.ok(skills[0].ts > 0);
});

test('activeCounts counts only recently-active agent files and running workflows', () => {
  const { sessionDir, subagents, wfAgents } = buildFixture();
  const now = Date.now();
  // make a1 + workflow agent look active, a2 stale
  utimesSync(join(subagents, 'agent-a1.jsonl'), new Date(now), new Date(now));
  utimesSync(join(wfAgents, 'agent-w1.jsonl'), new Date(now), new Date(now));
  utimesSync(join(wfAgents, 'journal.jsonl'), new Date(now), new Date(now));
  const old = new Date(now - 3600_000);
  utimesSync(join(subagents, 'agent-a2.jsonl'), old, old);

  const counts = activeCounts(sessionDir, { now, activeWithinMs: 45_000 });
  assert.equal(counts.agents, 2);
  assert.equal(counts.workflows, 1);
});

test('collectors tolerate a missing session dir', () => {
  const ghost = join(tmpdir(), 'hud-none', 'nope');
  assert.deepEqual(listAgents(ghost, { now: Date.now() }), []);
  assert.deepEqual(listWorkflows(ghost), []);
  assert.deepEqual(activeCounts(ghost, { now: Date.now() }), { agents: 0, workflows: 0 });
  assert.equal(lastActivityTs(join(ghost, 'x.jsonl')), null);
  assert.deepEqual(recentFailures(join(ghost, 'x.jsonl'), { now: Date.now() }), []);
});
