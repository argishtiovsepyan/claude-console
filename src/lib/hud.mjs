// The claude-console deep view for ONE session — always the session you're in,
// whether it lives in the main checkout or a worktree.
//
// Default layout is five columns (≥168 cols) — every live kind owns a lane:
//   rail | SHELLS | WORKFLOWS | AGENTS | gauges   (user-locked order)
// REMOTE+LOCAL close the rail column, and each live column fills its rows
// down to the LOCAL row (dynamic caps; overflow folds into "+N more").
// 124–167 folds to three columns (agents+workflows share the middle, shells
// under the gauges); 84–123 folds to two (gauges join the left rail);
// below 84 everything stacks. No titles, no rules, no PR row (user-locked).
// Every rendered string passes redact(); unknown data says "unknown".

import { basename } from 'node:path';
import { homedir } from 'node:os';
import { displayWidth, truncateDisplay, truncateMiddleDisplay, padEndDisplay } from './ansi.mjs';
import { renderBar, barLevel } from './bars.mjs';
import { formatTokens, formatReset } from './segments.mjs';
import { redact } from './redact.mjs';

const RAIL = 13; // fixed label rail — all left-column values start here
const C = {
  label: '38;5;245',
  section: '0;36',
  value: '0;37',
  dim: '38;5;245',
  gutter: '38;5;238',
  low: '38;5;154',
  mid: '38;5;220',
  high: '38;5;196',
  ultra: '38;5;141', // Claude Code's UI purple (xterm 141 ≈ #af87ff)
  run: '38;5;154',
  fail: '38;5;196',
};

export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${(m % 60).toString().padStart(2, '0')}m`;
}

function abbreviateHome(p) {
  const home = homedir();
  return p && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// A too-long path keeps only its root prefix (~/ or /Users/) before the …,
// giving the trailing directories all the remaining room.
function shortPath(p, max, ascii) {
  const prefix = /^(~\/|\/[^/]+\/)/.exec(p);
  return truncateMiddleDisplay(p, max, { ascii, headMax: prefix ? displayWidth(prefix[1]) : 4 });
}

function buildSections(data, ctx) {
  const { paint, icons, ascii, now, timeZone, show, gaugeCells, detailDescW } = ctx;
  const head = (t) => paint(C.section, t);
  const row = (label, value) => padEndDisplay(paint(C.label, label), RAIL) + value;
  const noneLine = paint(C.dim, 'none');
  const S = {};

  // ---------- location group (always on top, own group) ----------
  const loc = [];
  if (show.where) {
    // key/value like every other rail row: WORKSPACE = main terminal | worktree
    if (data.isWorktree) {
      loc.push(
        row(
          'WORKSPACE',
          paint('38;5;208', 'worktree' + icons.dot) + paint(C.value, data.worktreeName || (data.cwd ? basename(data.cwd) : 'unknown'))
        )
      );
    } else {
      loc.push(row('WORKSPACE', paint('38;5;220', 'main terminal')));
    }
    loc.push(
      row(
        'BRANCH',
        data.branch
          ? paint('0;36', data.branch) +
              (Number.isFinite(data.dirtyCount) && data.dirtyCount > 0 ? ` ${paint(C.mid, `+${data.dirtyCount}`)}` : '')
          : paint(C.dim, 'unknown')
      )
    );
  }
  S.loc = loc;

  // ---------- identity group ----------
  const ident = [];
  ident.push(row('MODEL', data.model?.name ? paint(C.value, data.model.name) : paint(C.dim, 'unknown')));
  if (data.effort) {
    // effort levels as Claude Code reports them (low … ultracode);
    // ultracode gets the Claude purple
    const effortColor = data.effort === 'ultracode' ? C.ultra : C.value;
    ident.push(row('EFFORT', paint(effortColor, data.effort)));
  }
  if (!data.alive) {
    ident.push(row('STATUS', paint(C.fail, `STALE ${icons.dash} claude process gone${data.pid ? ` (pid ${data.pid})` : ''}`)));
  } else {
    // the fastest-changing row gets state colors: busy green, idle yellow
    const st = data.registryStatus || 'alive';
    const stColor = st === 'busy' ? '0;36' : st === 'idle' ? C.mid : C.dim;
    ident.push(row('STATUS', paint(stColor, st)));
  }
  S.ident = ident;

  // REMOTE + LOCAL sit attached as the HUD's final full-width rows —
  // LOCAL shows the whole path, no ellipsis, capped only by the total width
  S.footer = show.where
    ? [
        row(
          'REMOTE',
          data.repo?.name
            ? paint(C.value, `${data.repo.owner ? `${data.repo.owner}/` : ''}${data.repo.name}`)
            : paint(C.dim, 'unknown')
        ),
        row('LOCAL', data.cwd ? paint(C.value, shortPath(abbreviateHome(data.cwd), ctx.localValW, ascii)) : paint(C.dim, 'unknown')),
      ]
    : [];

  // ---------- live detail (MIDDLE column: count row + rows per kind) ----------
  const CAP = 3;
  const countVal = (n) => paint(n > 0 ? C.run : C.dim, `${n} running`);
  // in a live column the count hugs its label (WORKSPACE-style gap);
  // in the rail it aligns with the other labeled rows
  const countRow = (label, n, tight) => (tight ? paint(C.label, label) + '    ' + countVal(n) : row(label, countVal(n)));
  const agents = data.agents ?? [];
  const running = agents.filter((a) => a.state === 'running');
  // grid5 columns show up to 6 rows — the 7th (LOCAL's row) is reserved for
  // the +N more overflow line; other modes cap at 3
  const fillCap = (n) => (ctx.liveRows ? Math.min(n, ctx.liveRows - 1) : CAP);
  const agentLines = [];
  const aCap = fillCap(running.length);
  // pack tight: model and description pad only to the longest visible value,
  // two-space gaps between the parts — ages still land in one column
  const shown = running.slice(0, aCap).map((a) => ({
    a,
    model: a.model || '',
    descText: truncateDisplay(
      redact(a.description || (a.isWorkflowAgent ? 'workflow agent' : a.agentType || a.agentId || 'agent')),
      detailDescW,
      { ascii }
    ),
  }));
  const modelW = Math.max(0, ...shown.map((s) => displayWidth(s.model)));
  const descW = Math.max(0, ...shown.map((s) => displayWidth(s.descText)));
  for (const s of shown) {
    agentLines.push(
      `${paint(C.run, icons.run)}  ` +
        padEndDisplay(paint(C.section, s.model), modelW + 2) +
        padEndDisplay(paint(C.value, s.descText), descW + 2) +
        paint(C.dim, Number.isFinite(s.a.lastActivityMs) ? formatAge(now - s.a.lastActivityMs) : '')
    );
  }
  if (running.length > aCap) agentLines.push(paint(C.dim, `   +${running.length - aCap} more`));
  S.agents = show.agents
    ? [countRow('AGENTS', running.length, ctx.tight.agents), ...(agentLines.length ? ['', ...agentLines] : [])]
    : [];

  const wfs = (data.workflows ?? []).filter((w) => w.status === 'running');
  const wfLines = [];
  const wCap = fillCap(wfs.length);
  for (const w of wfs.slice(0, wCap)) {
    // no bar — a done/total count reads better at this size; ultracode purple,
    // since that's the effort tier that unlocks workflows (distinct from the
    // green run markers and cyan model names)
    const prog =
      w.progress?.done != null && w.progress?.total
        ? paint(C.ultra, `(${w.progress.done}/${w.progress.total})`)
        : '';
    // the count hugs the name — no fixed padding — then the age
    wfLines.push(
      `${paint(C.section, icons.wf)}  ` +
        paint(C.value, truncateDisplay(w.workflowName || w.runId || 'workflow', ctx.wfNameW, { ascii })) +
        (prog ? `  ${prog}` : '') +
        (Number.isFinite(w.startTime) ? `  ${paint(C.dim, formatAge(now - w.startTime))}` : '')
    );
  }
  if (wfs.length > wCap) wfLines.push(paint(C.dim, `   +${wfs.length - wCap} more`));
  S.workflows = show.workflows
    ? [countRow('WORKFLOWS', wfs.length, ctx.tight.workflows), ...(wfLines.length ? ['', ...wfLines] : [])]
    : [];

  // ---------- shells: RIGHT column, under the gauges (count + rows) ----------
  const shells = data.shells ?? [];
  const shellLines = [];
  const sCap = fillCap(shells.length);
  if (show.shells) {
    shellLines.push(countRow('SHELLS', shells.length, ctx.tight.shells));
    if (shells.length) shellLines.push('');
    for (const sh of shells.slice(0, sCap)) {
      // one row per shell: $ purpose · age (the raw command stays off-screen)
      const purpose = redact(sh.description || 'purpose unknown');
      const dollar = paint(C.run, ascii ? '$' : '$');
      shellLines.push(
        dollar +
          '  ' +
          padEndDisplay(paint(C.value, truncateDisplay(purpose, ctx.railShellW, { ascii })), ctx.railShellW + 2) +
          (Number.isFinite(sh.elapsedMs) ? paint(C.dim, formatAge(sh.elapsedMs)) : '')
      );
    }
    if (shells.length > sCap) shellLines.push(paint(C.dim, `   +${shells.length - sCap} more`));
  }
  S.shells = shellLines;

  // ---------- gauges (titleless) ----------
  const limits = [];
  const gaugeRow = (label, pct, thresholds, detail) => {
    if (pct == null) {
      limits.push(row(label, paint(C.dim, 'unknown')));
      return;
    }
    const lvl = C[barLevel(pct, thresholds)];
    const bar = paint(lvl, `${renderBar(pct, gaugeCells, { ascii })} ${Math.round(pct)}%`);
    limits.push(row(label, `${bar}${detail ? `  ${paint(C.dim, detail)}` : ''}`));
  };
  gaugeRow(
    'CONTEXT',
    data.context?.usedPct ?? null,
    [50, 75],
    data.context?.totalIn != null && data.context?.size != null
      ? `${formatTokens(data.context.totalIn)}/${formatTokens(data.context.size)}`
      : null
  );
  const reset = (limit) => formatReset(limit?.resetsAt, { now, timeZone, ascii });
  gaugeRow('5-HOUR', data.rateLimits?.fiveHour?.pct ?? null, [70, 90], reset(data.rateLimits?.fiveHour));
  gaugeRow('7-DAY', data.rateLimits?.sevenDay?.pct ?? null, [70, 90], reset(data.rateLimits?.sevenDay));
  S.limits = show.limits ? limits : [];

  // ---------- optional: SKILLS / FAILURES ----------
  if (show.skills) {
    const skills = (data.skills ?? []).map((s) => redact(s.skill));
    S.skills = [head('SKILLS USED'), skills.length ? paint(C.value, skills.join(icons.dot)) : noneLine];
  } else S.skills = [];
  if (show.failures) {
    const failures = data.failures ?? [];
    const lines = [head(`FAILURES${icons.dot}last 10 min`)];
    if (!failures.length) lines.push(noneLine);
    for (const f of failures.slice(0, 6)) {
      lines.push(
        `${paint(C.fail, icons.fail)}  ` +
          paint(C.value, f.tool || 'tool') +
          paint(C.dim, Number.isFinite(f.ts) ? `${icons.dot}${formatAge(now - f.ts)} ago` : '')
      );
      if (f.snippet) lines.push(`   ${paint(C.dim, redact(f.snippet))}`);
    }
    S.failures = lines;
  } else S.failures = [];

  return S;
}

function joinBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    if (!b.length) continue;
    if (out.length) out.push('');
    out.push(...b);
  }
  return out;
}

export function renderSessionView(
  data,
  { width = 100, color = true, ascii = false, now = Date.now(), timeZone, sections = {}, layout, gutter = 'space', leadGuard = false, rowGap = false } = {}
) {
  // Claude Code trims leading whitespace off every statusline row; a braille
  // blank (U+2800) renders as empty space but is NOT whitespace. Costs 1 col.
  if (leadGuard && !ascii) width = Math.max(40, width - 1);
  const show = { where: true, limits: true, agents: true, workflows: true, skills: true, shells: true, failures: true, ...sections };
  const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  // each live kind gets its own glyph: 👾 agents · 🚀 workflows · $ shells
  const icons = ascii
    ? { run: '*', done: '+', fail: 'x', wf: '>', dot: ' | ', dash: '-' }
    : { run: '👾', done: '✔', fail: '✗', wf: '🚀', dot: ' · ', dash: '—' };

  // grid5 (default, wide): rail | agents | workflows | shells | gauges;
  // grid3: rail | agents+workflows | gauges rightmost
  const mode =
    layout === 'stack' ? 'stack' : width >= 168 ? 'grid5' : width >= 124 ? 'grid3' : width >= 84 ? 'grid2' : 'stack';
  const GUT_W = 3;
  // grid5 only: extra breathing room in the rail→shells gutter (~12% of the
  // rail), taken from the live budget so the grid still fits the width
  const RAIL_EXTRA = 6;
  const railExtra = mode === 'grid5' ? RAIL_EXTRA : 0;
  let widths = [width];
  if (mode === 'grid2') {
    const l = Math.min(52, Math.max(36, Math.floor((width - GUT_W) * 0.46)));
    widths = [l, width - l - GUT_W];
  } else if (mode === 'grid3') {
    const rail = Math.min(46, Math.max(38, Math.floor(width * 0.3)));
    const gauge = 40;
    widths = [rail, width - rail - gauge - 2 * GUT_W, gauge];
  } else if (mode === 'grid5') {
    // the rail widens (to a point) so LOCAL's full path fits un-ellipsized
    const localW = show.where && data.cwd ? RAIL + displayWidth(abbreviateHome(data.cwd)) : 0;
    const base = Math.min(44, Math.max(34, Math.floor(width * 0.21)));
    const rail = Math.min(50, Math.max(base, localW));
    const gauge = 36;
    const live = width - rail - gauge - 4 * GUT_W - railExtra;
    const agentsW = Math.floor(live * 0.4);
    const wfW = Math.floor(live * 0.31);
    widths = [rail, live - agentsW - wfW, wfW, agentsW, gauge];
  }
  const detailColW = mode === 'grid5' ? widths[3] : mode === 'grid3' || mode === 'grid2' ? widths[1] : width;
  const ctx = {
    paint,
    icons,
    ascii,
    now,
    timeZone,
    show,
    gaugeCells: mode === 'grid5' ? 8 : mode === 'grid3' ? 10 : mode === 'grid2' ? 12 : 14,
    // grid5 agent rows carry only icon+model+age around the desc → less slack
    detailDescW: Math.max(12, detailColW - (mode === 'grid5' ? 20 : 24)),
    wfNameW: mode === 'grid5' ? Math.max(10, widths[2] - 14) : 18,
    // counts hug their labels wherever they head a live column, not the rail
    tight: { agents: mode !== 'stack', workflows: mode !== 'stack', shells: mode === 'grid5' },
    // grid5 live columns fill their rows down to the LOCAL row: rail height
    // minus the count row and its breathing row
    liveRows:
      mode === 'grid5'
        ? Math.max(5, (show.where ? 3 : 0) + 2 + (data.effort ? 1 : 0) + (show.where ? 3 : 0)) - 2
        : null,
    // shells render in their own column (grid5), the right column (grid3),
    // or the left rail (grid2/stack)
    railShellW: Math.max(12, (mode === 'grid5' ? widths[1] : mode === 'grid3' ? widths[2] : widths[0]) - 12),
    // LOCAL paths longer than their row truncate in the MIDDLE (tail visible)
    localValW: Math.max(16, (mode === 'grid5' ? widths[0] : width) - RAIL),
  };
  const S = buildSections(data, ctx);

  const gut = gutter === 'space' ? ' '.repeat(GUT_W) : ` ${paint(C.gutter, ascii ? '|' : '│')} `;
  // the rail (column 0) gets a wider gutter in grid5; every other gap is gut
  const gutAfter = (k) => (k === 0 && railExtra ? gut + ' '.repeat(railExtra) : gut);
  const zip = (cols) => {
    const n = Math.max(...cols.map((c) => c.length));
    const out = [];
    for (let i = 0; i < n; i++) {
      let line = '';
      cols.forEach((col, k) => {
        const cell = truncateDisplay(col[i] ?? '', widths[k], { ascii });
        line += k < cols.length - 1 ? padEndDisplay(cell, widths[k]) + gutAfter(k) : cell;
      });
      out.push(line.trimEnd());
    }
    return out;
  };

  // gauges always breathe; rowGap (opt-in) spaces every rail row
  const airy = (block) => block.flatMap((l, i) => (i === 0 ? [l] : ['', l]));
  const railT = (block) => (rowGap ? airy(block) : block);
  const railBlocks = [railT(S.loc), railT(S.ident)];
  // middle: counts + rows per kind (never empty — counts always render)
  const middleBlocks = [S.agents, S.workflows, S.skills, S.failures];
  // right: gauges with SHELLS beneath them
  const rightBlocks = [airy(S.limits), S.shells];

  let lines;
  if (mode === 'grid5') {
    // REMOTE+LOCAL close the rail column so live columns end at LOCAL's row;
    // gauges stack under CONTEXT at the top, airy (blank between each)
    lines = zip([
      joinBlocks([...railBlocks, S.footer]),
      S.shells,
      S.workflows,
      joinBlocks([S.agents, S.skills, S.failures]),
      airy(S.limits),
    ]);
  } else if (mode === 'grid3') {
    lines = zip([joinBlocks(railBlocks), joinBlocks(middleBlocks), joinBlocks(rightBlocks)]);
  } else if (mode === 'grid2') {
    lines = zip([joinBlocks([...railBlocks, ...rightBlocks]), joinBlocks(middleBlocks)]);
  } else {
    lines = joinBlocks([...railBlocks, ...rightBlocks, ...middleBlocks]);
  }

  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (mode !== 'grid5' && S.footer.length) lines.push('', ...S.footer);
  let outLines = lines.map((l) => (displayWidth(l) > width ? truncateDisplay(l, width, { ascii }) : l));
  if (leadGuard && !ascii) {
    // spacer rows top and bottom so the HUD never touches the input box
    // above or Claude Code's own status row below
    outLines = ['⠀', ...outLines.map((l) => `⠀${l}`), '⠀'];
  }
  return outLines.join('\n');
}

export function pickSession(sessions, { explicitId, envSessionId, cwd } = {}) {
  if (!sessions?.length) return null;
  const findById = (id) => sessions.find((s) => s.sessionId === id || (id && s.sessionId?.startsWith(id)));
  if (explicitId) return findById(explicitId) ?? null;
  if (envSessionId) {
    const hit = findById(envSessionId);
    if (hit) return hit;
  }
  if (cwd) {
    const matches = sessions.filter((s) => s.cwd && (cwd === s.cwd || cwd.startsWith(`${s.cwd}/`)));
    if (matches.length) {
      matches.sort(
        (a, b) =>
          Number(b.alive) - Number(a.alive) ||
          (b.cwd?.length ?? 0) - (a.cwd?.length ?? 0) ||
          (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
      );
      return matches[0];
    }
  }
  const sorted = [...sessions].sort(
    (a, b) => Number(b.alive) - Number(a.alive) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  );
  return sorted[0] ?? null;
}
