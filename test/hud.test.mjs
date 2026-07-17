import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSessionView, pickSession } from '../src/lib/hud.mjs';
import { displayWidth } from '../src/lib/ansi.mjs';

const NOW = 1784252773000;

function sessionData(overrides = {}) {
  return {
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    name: 'Ship the payments dashboard',
    alive: true,
    registryStatus: 'busy',
    pid: 8155,
    cwd: '/Users/dev/Desktop/X1/xavior-core-1',
    model: { id: 'claude-fable-5', name: 'Fable 5' },
    effort: 'xhigh',
    branch: 'develop',
    dirtyCount: 3,
    isWorktree: false,
    worktreeName: null,
    repo: { host: 'github.com', owner: 'acme', name: 'my-repo' },
    pr: { number: 6612, reviewState: 'APPROVED' },
    cost: { usd: 5.7898, durationMs: 9364000 },
    context: { usedPct: 12, totalIn: 120259, size: 1000000 },
    rateLimits: {
      fiveHour: { pct: 55, resetsAt: 1784259600 },
      sevenDay: { pct: 11, resetsAt: 1784386800 },
    },
    agents: [
      { agentId: 'a1', agentType: 'general-purpose', description: 'recon docs', model: 'sonnet', state: 'running', lastActivityMs: NOW - 5000, isWorkflowAgent: false },
      { agentId: 'a2', agentType: 'Explore', description: 'quick check', model: null, state: 'done', lastActivityMs: NOW - 60000, isWorkflowAgent: false },
    ],
    workflows: [{ runId: 'wf_x', workflowName: 'hud-discovery', status: 'running', progress: { done: 3, total: 5 }, agentCount: 5 }],
    skills: [{ skill: 'superpowers:test-driven-development', ts: NOW - 100000 }, { skill: 'artifact-design', ts: NOW - 50000 }],
    shells: [{ command: 'npm run test --workspace @xavior/api', description: 'Run full API test suite', elapsedMs: 12000 }],
    failures: [{ ts: NOW - 180000, tool: 'Bash', snippet: 'Command failed: npm run build TS2304' }],
    lastActivityMs: NOW - 2000,
    ...overrides,
  };
}

// default test render: grid2 (width 100) — deterministic and line-start friendly
function render(overrides = {}, opts = {}) {
  return renderSessionView(sessionData(overrides), { width: 100, color: false, ascii: false, now: NOW, timeZone: 'UTC', ...opts });
}

const stack = (overrides = {}, opts = {}) =>
  renderSessionView(sessionData(overrides), { width: 120, color: false, now: NOW, timeZone: 'UTC', layout: 'stack', ...opts });

// ---------- rail ----------

test('rail carries every labeled row including AGENTS/WORKFLOWS/SHELLS counts', () => {
  const out = render();
  for (const label of ['MODEL', 'EFFORT', 'STATUS', 'WORKSPACE', 'BRANCH', 'LOCAL', 'REMOTE', 'AGENTS', 'WORKFLOWS', 'SHELLS']) {
    assert.ok(out.includes(label), `${label} missing:\n${out}`);
  }
});

test('no section titles, no banner, no PR row', () => {
  const out = render();
  assert.ok(!/^WHAT/m.test(out), out);
  assert.ok(!/^LIMITS/m.test(out), out);
  assert.ok(!/^WHERE/m.test(out), out);
  assert.ok(!out.includes('BUILD CLAUDE CODE'), out);
  assert.ok(!/^PR\b/m.test(out), out);
  assert.ok(!out.includes('#6612'), out);
});

test('location group on top with a blank line before the rest', () => {
  const lines = stack().split('\n');
  assert.ok(/^WORKSPACE\s+main terminal/.test(lines[0]), lines[0]);
  assert.ok(/^BRANCH\s+develop \+3/.test(lines[1]), lines[1]);
  assert.equal(lines[2], '', lines.slice(0, 4).join('\n'));
  assert.ok(/^MODEL/.test(lines[3]), lines[3]);
  assert.ok(/^EFFORT/.test(lines[4]), lines[4]);
  const wt = stack({ isWorktree: true, worktreeName: 'gmail-native-tabs' }).split('\n');
  assert.ok(/^WORKSPACE\s+worktree · gmail-native-tabs/.test(wt[0]), wt[0]);
});

test('STATUS is just busy/idle — no last-activity text', () => {
  const out = render();
  assert.ok(/STATUS\s+busy(\s|$)/m.test(out), out);
  assert.ok(!out.includes('last activity'), out);
});

test('count rows read like BRANCH rows: label + N running', () => {
  const out = render();
  assert.ok(/AGENTS\s+1 running/.test(out), out);
  assert.ok(/WORKFLOWS\s+1 running/.test(out), out);
  assert.ok(/SHELLS\s+1 running/.test(out), out);
  assert.ok(!out.includes('finished'), out);
});

test('EFFORT: own row, ultracode purple, omitted when absent', () => {
  const colored = renderSessionView(sessionData({ effort: 'ultracode' }), { width: 100, color: true, now: NOW, timeZone: 'UTC' });
  assert.ok(/\x1b\[38;5;141multracode/.test(colored), 'ultracode not purple');
  const plain = renderSessionView(sessionData({ effort: 'xhigh' }), { width: 100, color: true, now: NOW, timeZone: 'UTC' });
  assert.ok(!/\x1b\[38;5;141mxhigh/.test(plain), 'xhigh must not be purple');
  assert.ok(!render({ effort: null }).includes('EFFORT'));
});

// ---------- live detail ----------

test('detail shows only running agents, model first then description, max 3, +N more', () => {
  const out = render();
  assert.ok(/👾\s+sonnet\s+recon docs/.test(out), out);
  assert.ok(!out.includes('quick check'), out); // done agent: no row
  const many = render({
    agents: Array.from({ length: 10 }, (_, i) => ({
      agentId: `r${i}`, description: `live agent ${i}`, model: 'sonnet', state: 'running', lastActivityMs: NOW - i * 1000,
    })),
  });
  assert.ok(many.includes('live agent 2'), many);
  assert.ok(!many.includes('live agent 3'), many);
  assert.ok(many.includes('+7 more'), many);
  assert.ok(/AGENTS\s+10 running/.test(many), many);
});

test('agent rows pack tight: two-space gaps off the longest model/desc, ages still aligned', () => {
  const data = sessionData({
    agents: [
      { agentId: 'a1', description: 'recon docs', model: 'sonnet', state: 'running', lastActivityMs: NOW - 5000 },
      { agentId: 'a2', description: 'a bigger task', model: 'haiku', state: 'running', lastActivityMs: NOW - 9000 },
    ],
  });
  const out = renderSessionView(data, { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } });
  const l1 = out.split('\n').find((l) => l.includes('recon docs'));
  const l2 = out.split('\n').find((l) => l.includes('a bigger task'));
  // gaps hug the longest values: sonnet (longest model) and the longer desc
  assert.equal(l1.indexOf('recon docs') - (l1.indexOf('sonnet') + 'sonnet'.length), 2, l1);
  assert.equal(l2.indexOf('9s') - (l2.indexOf('a bigger task') + 'a bigger task'.length), 2, l2);
  // columns still align across rows
  assert.equal(l1.indexOf('recon docs'), l2.indexOf('a bigger task'), `${l1}\n${l2}`);
  assert.equal(l1.indexOf('5s'), l2.indexOf('9s'), `${l1}\n${l2}`);
});

test('running workflows show name + progress + age; completed ones are invisible', () => {
  const out = render({
    workflows: [
      { runId: 'wf_a', workflowName: 'hud-discovery', status: 'running', progress: { done: 3, total: 5 }, startTime: NOW - 120000 },
      { runId: 'wf_c', workflowName: 'old-finished', status: 'completed', progress: null },
    ],
  });
  assert.ok(/🚀\s+hud-discovery/.test(out), out);
  assert.ok(out.includes('(3/5)'), out);
  const wfLine = out.split('\n').find((l) => l.includes('hud-discovery'));
  assert.ok(!wfLine.includes('█') && !wfLine.includes('░'), `no progress bar on workflow rows: ${wfLine}`);
  assert.ok(/\(3\/5\)\s+2m/.test(wfLine), `workflow rows carry their age: ${wfLine}`);
  const colored = renderSessionView(sessionData(), { width: 100, color: true, now: NOW, timeZone: 'UTC' });
  assert.ok(/\x1b\[38;5;141m\(3\/5\)/.test(colored), 'workflow count must be purple with purple parentheses');
  assert.ok(!out.includes('old-finished'), out);
  assert.ok(/WORKFLOWS\s+1 running/.test(out), out);
});

test('shells: one row each — $ purpose with aligned ages, the raw command never renders', () => {
  const out = render({
    shells: [
      { command: 'node --test', description: 'short', elapsedMs: 12000 },
      { command: 'curl -H "Authorization: Bearer abc.def" https://x', description: 'a much longer purpose here', elapsedMs: 2000 },
    ],
  });
  const lines = out.split('\n');
  const a = lines.find((l) => l.includes('short'));
  const b = lines.find((l) => l.includes('a much longer purpose'));
  assert.equal(a.indexOf('12s'), b.indexOf('2s'), `${a}\n${b}`);
  assert.ok(!out.includes('node --test'), out);
  assert.ok(!out.includes('abc.def'), out);
});

test('shells sit beneath the gauges (after 7-DAY)', () => {
  const lines = stack().split('\n');
  const d = lines.findIndex((l) => /^7-DAY/.test(l));
  assert.ok(d >= 0, lines.join('\n'));
  assert.equal(lines[d + 1], '', lines.slice(d, d + 3).join('\n'));
  assert.ok(/^SHELLS\s+1 running/.test(lines[d + 2]), lines.slice(d, d + 3).join('\n'));
});

test('grid3: middle = counts + agent/workflow rows; shells under gauges on the right', () => {
  const out = renderSessionView(sessionData(), { width: 150, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } });
  const first = out.split('\n')[0];
  assert.ok(/WORKSPACE.*AGENTS.*CONTEXT/.test(first), first);
  assert.ok(!/^AGENTS/m.test(out), 'AGENTS count belongs to the middle column');
  assert.ok(!/^\$/m.test(out), 'shell rows belong to the right column');
});

test('STATUS value is colored: busy green, idle yellow', () => {
  const busy = renderSessionView(sessionData({ registryStatus: 'busy' }), { width: 100, color: true, now: NOW, timeZone: 'UTC' });
  assert.ok(/\x1b\[0;36mbusy/.test(busy), 'busy not cyan');
  const idle = renderSessionView(sessionData({ registryStatus: 'idle' }), { width: 100, color: true, now: NOW, timeZone: 'UTC' });
  assert.ok(/\x1b\[38;5;220midle/.test(idle), 'idle not yellow');
});

test('leadGuard adds spacer rows top AND bottom (gap from input box and Claude UI)', () => {
  const out = renderSessionView(sessionData(), { width: 112, color: false, now: NOW, timeZone: 'UTC', leadGuard: true });
  const lines = out.split('\n');
  assert.equal(lines[0], '⠀', JSON.stringify(lines[0]));
  assert.equal(lines[lines.length - 1], '⠀', JSON.stringify(lines[lines.length - 1]));
});

test('empty live sections: counts say 0 running, no placeholder rows', () => {
  const out = render(
    { agents: [], workflows: [], shells: [], failures: [], skills: [] },
    { sections: { skills: false, failures: false } }
  );
  assert.ok(/AGENTS\s+0 running/.test(out), out);
  assert.ok(/WORKFLOWS\s+0 running/.test(out), out);
  assert.ok(/SHELLS\s+0 running/.test(out), out);
  assert.ok(!/\bnone\b/.test(out), out);
  assert.ok(!out.includes('👾'), out);
});

test('session name and skills never leak secrets', () => {
  const out = render(
    { name: 'deploy with token=abc123xyz9', skills: [{ skill: 'x token=supersecret9', ts: NOW }] },
    { sections: { skills: true, failures: false } }
  );
  assert.ok(!out.includes('abc123xyz9'), out);
  assert.ok(!out.includes('supersecret9'), out);
});

// ---------- layout ----------

test('workspace colors: golden main terminal; orange worktree prefix, white name', () => {
  const main = renderSessionView(sessionData(), { width: 100, color: true, now: NOW, timeZone: 'UTC' });
  assert.ok(/\x1b\[38;5;220mmain terminal/.test(main), 'main terminal not golden');
  const wt = renderSessionView(sessionData({ isWorktree: true, worktreeName: 'gmail-native-tabs' }), { width: 100, color: true, now: NOW, timeZone: 'UTC' });
  assert.ok(/\x1b\[38;5;208mworktree/.test(wt), 'worktree prefix not orange');
  assert.ok(/\x1b\[0;37mgmail-native-tabs/.test(wt), 'worktree name not white');
});

test('middle column always shows counts, so three columns are always visible', () => {
  const out = renderSessionView(sessionData({ agents: [], workflows: [] }), { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } });
  const first = out.split('\n')[0];
  assert.ok(/WORKSPACE.*AGENTS\s+0 running.*CONTEXT/.test(first), first);
});

test('grid5 at >=168: shells, workflows, agents each get their own column, gauges rightmost', () => {
  const out = renderSessionView(sessionData(), { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } });
  const first = out.split('\n')[0];
  assert.ok(/WORKSPACE.*SHELLS.*WORKFLOWS.*AGENTS.*CONTEXT/.test(first), first);
  for (const line of out.split('\n')) assert.ok(displayWidth(line) <= 186, `${displayWidth(line)}: ${line}`);
});

test('grid5 rail→shells gutter carries extra breathing room', () => {
  const out = renderSessionView(sessionData({ shells: [{ command: 'x', description: 'short', elapsedMs: 12000 }] }), { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } });
  const first = out.split('\n')[0];
  const shells = first.indexOf('SHELLS');
  // with an even split SHELLS would sit at rail(48)+gut(3)=51; the widened
  // rail→shells gutter pushes it clearly further right
  assert.ok(shells >= 55, `rail→shells gap should be widened: SHELLS at ${shells}\n${first}`);
  // a shell row still lines up under its own SHELLS head
  const shellRow = out.split('\n').find((l) => l.includes('short'));
  assert.equal(shellRow.indexOf('$'), shells, `${first}\n${shellRow}`);
});

test('grid5 rows land under their own column heads', () => {
  const out = renderSessionView(
    sessionData({
      workflows: [{ runId: 'wf_x', workflowName: 'flow', status: 'running', progress: { done: 3, total: 5 }, startTime: NOW - 120000 }],
      shells: [{ command: 'x', description: 'short', elapsedMs: 12000 }],
    }),
    { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } }
  );
  const lines = out.split('\n');
  const first = lines[0];
  const cols = ['SHELLS', 'WORKFLOWS', 'AGENTS', 'CONTEXT'].map((h) => first.indexOf(h));
  assert.ok(cols.every((c, i) => c > (cols[i - 1] ?? 0)), first);
  const shellRow = lines.find((l) => l.includes('short'));
  const st = shellRow.indexOf('$');
  assert.ok(st >= cols[0] && st < cols[1], shellRow);
  const wfRow = lines.find((l) => l.includes('flow'));
  const wt = wfRow.indexOf('🚀');
  assert.ok(wt >= cols[1] && wt < cols[2], wfRow);
  const agentRow = lines.find((l) => l.includes('recon docs'));
  const at = agentRow.indexOf('👾');
  assert.ok(at >= cols[2] && at < cols[3], agentRow);
});

test('grid5 counts keep all five columns alive when nothing is running', () => {
  const out = renderSessionView(sessionData({ agents: [], workflows: [], shells: [] }), { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } });
  const first = out.split('\n')[0];
  assert.ok(/WORKSPACE.*SHELLS\s+0 running.*WORKFLOWS\s+0 running.*AGENTS\s+0 running.*CONTEXT/.test(first), first);
});

test('grid5 live columns fill the rows down to LOCAL: workflows up to 7, +N more past that', () => {
  const many = sessionData({
    agents: Array.from({ length: 10 }, (_, i) => ({
      agentId: `r${i}`, description: `live agent ${i}`, model: 'sonnet', state: 'running', lastActivityMs: NOW - i * 1000,
    })),
    workflows: Array.from({ length: 7 }, (_, i) => ({
      runId: `wf_${i}`, workflowName: `flow-${i}`, status: 'running', progress: { done: i, total: 7 },
    })),
    shells: Array.from({ length: 5 }, (_, i) => ({
      command: `cmd-${i}`, description: `shell ${i}`, elapsedMs: 1000 * (i + 1),
    })),
  });
  const out = renderSessionView(many, { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } });
  // every live column shows at most 6 rows; the 7th is the +N more line
  assert.ok(out.includes('live agent 5'), out);
  assert.ok(!out.includes('live agent 6'), out);
  assert.ok(out.includes('+4 more'), out);
  // 7 workflows → 6 🚀 rows + "+1 more"
  assert.ok(out.includes('flow-5'), out);
  assert.ok(!out.includes('flow-6'), out);
  assert.equal((out.match(/🚀/g) || []).length, 6, out);
  assert.ok(out.includes('+1 more'), out);
  // shells are single-row now: all 5 fit, and no raw command renders
  assert.ok(out.includes('shell 4'), out);
  assert.ok(!out.includes('cmd-0'), out);
});

test('live-column counts hug their labels and get a blank row before details', () => {
  const out = renderSessionView(sessionData(), { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } });
  const lines = out.split('\n');
  assert.ok(lines[0].includes('AGENTS    1 running'), lines[0]);
  assert.ok(lines[0].includes('WORKFLOWS    1 running'), lines[0]);
  assert.ok(lines[0].includes('SHELLS    1 running'), lines[0]);
  const glyphs = (l) => l.includes('👾') || l.includes('🚀') || l.includes('$');
  assert.ok(!glyphs(lines[1]), `row after counts must be a separator: ${lines[1]}`);
  assert.ok(lines[2].includes('👾') && lines[2].includes('🚀') && lines[2].includes('$'), lines[2]);
});

test('rail: blank under STATUS; REMOTE+LOCAL attached as the final rows, full path, no ellipsis', () => {
  const out = renderSessionView(sessionData(), { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } });
  const lines = out.split('\n');
  const si = lines.findIndex((l) => /^STATUS/.test(l));
  assert.ok(si > 0, out);
  assert.ok(!/^(REMOTE|LOCAL)/.test(lines[si + 1]), lines[si + 1]);
  const ri = lines.findIndex((l) => /^REMOTE/.test(l));
  assert.ok(/^REMOTE\s+acme\/my-repo/.test(lines[ri]), lines[ri]);
  assert.ok(/^LOCAL/.test(lines[ri + 1]), `LOCAL must sit directly under REMOTE: ${lines[ri + 1]}`);
  const last = lines[lines.length - 1].trimEnd();
  assert.ok(/^LOCAL\s+\/Users\/dev\/Desktop\/X1\/xavior-core-1(\s|$)/.test(last), last);
  assert.ok(!last.includes('…'), last);
});

test('grid5 gauges: stacked under CONTEXT at the top with a breathing row between each', () => {
  const out = renderSessionView(sessionData(), { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } });
  const lines = out.split('\n');
  assert.ok(lines[0].includes('CONTEXT'), lines[0]);
  assert.ok(!lines[1].includes('5-HOUR'), lines[1]);
  assert.ok(lines[2].includes('5-HOUR'), lines[2]);
  assert.ok(!lines[3].includes('7-DAY'), lines[3]);
  assert.ok(lines[4].includes('7-DAY'), lines[4]);
  const ri = lines.findIndex((l) => /^REMOTE/.test(l));
  const li = lines.findIndex((l) => /^LOCAL/.test(l));
  assert.ok(ri > 0 && li === ri + 1, out);
  assert.ok(!lines[ri].includes('5-HOUR') && !lines[li].includes('7-DAY'), `gauges must not sit on the footer rows:\n${lines[ri]}\n${lines[li]}`);
});

test('gauge bars are the classic full-block bars (█ filled, ░ empty)', () => {
  const out = render();
  const ctx = out.split('\n').find((l) => /CONTEXT/.test(l));
  assert.ok(/█+░+/.test(ctx), ctx);
  for (const bad of ['▇', '▆', '▬', '▮']) assert.ok(!ctx.includes(bad), `${bad} in: ${ctx}`);
});

test('workflow progress bar hugs the name (two-space gap, no fixed padding)', () => {
  const out = renderSessionView(
    sessionData({ workflows: [{ runId: 'wf_s', workflowName: 'flow', status: 'running', progress: { done: 3, total: 5 } }] }),
    { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } }
  );
  assert.ok(/🚀\s+flow {2}\(3\/5\)/.test(out), out);
});

test('long LOCAL paths shrink to the root prefix + … + as much tail as fits', () => {
  const out = renderSessionView(
    sessionData({ cwd: '/Users/dev/Desktop/X1/xavior-core-1/.claude/worktrees/claude-terminal-hud' }),
    { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } }
  );
  const local = out.split('\n').find((l) => /^LOCAL/.test(l));
  assert.ok(/^LOCAL\s+\/Users\/…/.test(local), local);
  assert.ok(local.includes('worktrees/claude-terminal-hud'), local);
});

test('grid5 gauge details stay intact (no clipped reset/token text)', () => {
  const out = renderSessionView(sessionData(), { width: 186, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } });
  assert.ok(out.includes('120k/1M'), out);
  assert.ok(out.includes('→03:40'), out);
});

test('124–167 keeps grid3: workflows and shells do not head their own columns', () => {
  const out = renderSessionView(sessionData(), { width: 160, color: false, now: NOW, timeZone: 'UTC', sections: { skills: false, failures: false } });
  const first = out.split('\n')[0];
  assert.ok(/WORKSPACE.*AGENTS.*CONTEXT/.test(first), first);
  assert.ok(!first.includes('WORKFLOWS'), first);
  assert.ok(!first.includes('SHELLS'), first);
});

test('grid3 is the default at >=124: gauges are the rightmost column', () => {
  const out = renderSessionView(sessionData(), { width: 150, color: false, now: NOW, timeZone: 'UTC' });
  const first = out.split('\n')[0];
  assert.ok(/WORKSPACE.*CONTEXT/.test(first), first);
  assert.ok(!/^CONTEXT/m.test(out), 'gauges must not be in the left rail at grid3');
  for (const line of out.split('\n')) assert.ok(displayWidth(line) <= 150, `${displayWidth(line)}: ${line}`);
});

test('84–123 folds to two columns with gauges in the left rail', () => {
  const out = render();
  assert.ok(/^CONTEXT/m.test(out), out);
  assert.ok(/^5-HOUR/m.test(out), out);
});

test('gauges always breathe (blank row between bars)', () => {
  const lines = render().split('\n');
  const ci = lines.findIndex((l) => /^CONTEXT/.test(l));
  assert.ok(ci >= 0, lines.join('\n'));
  assert.ok(!/^5-HOUR/.test(lines[ci + 1]), lines.slice(ci, ci + 3).join('\n'));
  assert.ok(/^5-HOUR/.test(lines[ci + 2]), lines.slice(ci, ci + 3).join('\n'));
});

test('narrow widths stack; every width stays in bounds', () => {
  const narrow = renderSessionView(sessionData(), { width: 70, color: false, now: NOW, timeZone: 'UTC' });
  assert.ok(!/WORKSPACE.*MODEL/.test(narrow.split('\n')[0]), narrow);
  for (const width of [60, 90, 120, 150, 190]) {
    const out = renderSessionView(sessionData(), { width, color: false, now: NOW, timeZone: 'UTC' });
    for (const line of out.split('\n')) assert.ok(displayWidth(line) <= width, `${width}: ${line}`);
  }
});

test('whitespace gutter default; dim bar opt-in', () => {
  assert.ok(!render().includes('│'));
  assert.ok(renderSessionView(sessionData(), { width: 100, color: false, now: NOW, timeZone: 'UTC', gutter: 'bar' }).includes('│'));
});

test('rowGap opt-in spaces the rail rows', () => {
  const lines = renderSessionView(sessionData(), { width: 100, color: false, now: NOW, timeZone: 'UTC', rowGap: true }).split('\n');
  const mi = lines.findIndex((l) => /^MODEL/.test(l));
  assert.ok(!/^EFFORT/.test(lines[mi + 1]), lines.join('\n'));
});

test('leadGuard prefixes every line with a braille blank and stays in width', () => {
  const out = renderSessionView(sessionData(), { width: 112, color: false, now: NOW, timeZone: 'UTC', leadGuard: true });
  for (const line of out.split('\n')) {
    assert.ok(line.startsWith('⠀'), JSON.stringify(line.slice(0, 12)));
    assert.ok(displayWidth(line) <= 112, `${displayWidth(line)}: ${line}`);
  }
  assert.ok(!render().includes('⠀'), 'leadGuard must be off by default');
});

// ---------- honesty ----------

test('unknown values are labeled, never invented', () => {
  const out = render({ context: null, rateLimits: null, branch: null, repo: null, cost: null });
  assert.ok(out.includes('unknown'), out);
  assert.ok(!out.includes('null'), out);
  assert.ok(!out.includes('undefined'), out);
});

test('dead session is flagged loudly', () => {
  assert.ok(/STALE/.test(render({ alive: false })));
});

test('sections config can hide skills and failures', () => {
  const out = render({}, { sections: { skills: false, failures: false } });
  assert.ok(!out.includes('SKILLS USED'), out);
  assert.ok(!out.includes('FAILURES'), out);
});

// ---------- session picking ----------

test('pickSession prefers explicit id, then env, then cwd match, then recency', () => {
  const sessions = [
    { sessionId: 's-a', cwd: '/repo/a', alive: true, updatedAt: 100 },
    { sessionId: 's-b', cwd: '/repo/b', alive: true, updatedAt: 200 },
    { sessionId: 's-c', cwd: '/repo/c', alive: false, updatedAt: 300 },
  ];
  assert.equal(pickSession(sessions, { explicitId: 's-a' }).sessionId, 's-a');
  assert.equal(pickSession(sessions, { envSessionId: 's-b' }).sessionId, 's-b');
  assert.equal(pickSession(sessions, { cwd: '/repo/a' }).sessionId, 's-a');
  assert.equal(pickSession(sessions, {}).sessionId, 's-b');
  assert.equal(pickSession([], {}), null);
});

test('pickSession matches sessions running in a subdirectory cwd', () => {
  const sessions = [{ sessionId: 's-a', cwd: '/repo/a', alive: true, updatedAt: 100 }];
  assert.equal(pickSession(sessions, { cwd: '/repo/a/packages/web' }).sessionId, 's-a');
});
