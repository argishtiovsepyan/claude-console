// Width-aware statusline renderers.
//
//   renderLine        — single-row legacy-compatible layout
//   renderStatusLines — layout dispatcher: 'block' (default, two rows:
//                       identity row + gauges row) or 'line'
//
// Both build prioritized segments and degrade deterministically until the
// output fits: optional info drops first, bars collapse to percentages
// together (visual coherence), essentials survive longest, and a final hard
// truncate guarantees no row can ever wrap or corrupt the terminal.

import { displayWidth, truncateDisplay } from './ansi.mjs';
import { renderBar, barLevel } from './bars.mjs';

const COLORS = {
  branch: '0;36',
  label: '0;37',
  dim: '38;5;245',
  low: '38;5;154',
  mid: '38;5;220',
  high: '38;5;196',
};

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

export function formatTokens(n) {
  if (!Number.isFinite(n)) return null;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatReset(epochSec, { now = Date.now(), timeZone, ascii = false } = {}) {
  if (!Number.isFinite(epochSec)) return null;
  const arrow = ascii ? '->' : '→';
  const d = new Date(epochSec * 1000);
  const tz = timeZone ? { timeZone } : {};
  try {
    // within 24h a clock time is always the useful answer (a 5h window
    // resetting shortly after midnight must not read as "→Fri");
    // only genuinely-distant resets get a weekday
    if (epochSec * 1000 - now < 24 * 3600_000) {
      const hm = new Intl.DateTimeFormat('en-US', { ...tz, hour12: false, hour: '2-digit', minute: '2-digit' }).format(d);
      return `${arrow}${hm}`;
    }
    return `${arrow}${new Intl.DateTimeFormat('en-US', { ...tz, weekday: 'short' }).format(d)}`;
  } catch {
    return null;
  }
}

function makeCtx(config) {
  const ascii = !!config.style.ascii;
  const colorOn = config.style.color !== false;
  return {
    cfg: config,
    ascii,
    paint: (code, s) => (colorOn ? `\x1b[${code}m${s}\x1b[0m` : s),
    sym: { warn: ascii ? '!' : '⚠', worktree: ascii ? 'wt ' : '⎇' },
    pctOf: (v) => `${Math.round(v)}%`,
  };
}

function warnSegment(status, ctx) {
  const { cfg, paint, sym, pctOf } = ctx;
  const warns = [];
  const fh = status.rateLimits?.fiveHour?.pct;
  const sd = status.rateLimits?.sevenDay?.pct;
  const cw = status.context?.usedPct;
  if (fh != null && Math.round(fh) >= cfg.thresholds.usageAlert) warns.push(`${sym.warn} 5h ${pctOf(fh)}`);
  if (sd != null && Math.round(sd) >= cfg.thresholds.usageAlert) warns.push(`${sym.warn} 7d ${pctOf(sd)}`);
  if (cw != null && Math.round(cw) >= cfg.thresholds.contextAlert) warns.push(`${sym.warn} ctx ${pctOf(cw)}`);
  return warns.length ? { id: 'warn', form: paint(COLORS.high, warns.join(' ')) } : null;
}

function branchSegment(status, git, ctx) {
  if (!git.branch) return null;
  const { paint, sym, ascii } = ctx;
  const isWorktree = Boolean(status.gitWorktree || git.isWorktree);
  const wt = isWorktree ? sym.worktree : '';
  const dirty = git.dirtyCount > 0 ? ` ${paint(COLORS.mid, `+${git.dirtyCount}`)}` : '';
  return {
    id: 'branch',
    form: paint(COLORS.branch, `${wt}${git.branch}`) + dirty,
    alt: paint(COLORS.branch, `${wt}${truncateDisplay(git.branch, 12, { ascii })}`) + dirty,
  };
}

function activitySegment(counts, ctx) {
  const act = [];
  if (counts.agents > 0) act.push(`ag:${counts.agents}`);
  if (counts.workflows > 0) act.push(`wf:${counts.workflows}`);
  if (counts.procs > 0) act.push(`ps:${counts.procs}`);
  return act.length ? { id: 'activity', form: ctx.paint(COLORS.dim, act.join(' ')) } : null;
}

// Degrade `segs` in-place order until the joined line fits `width`.
function fit(segs, width, separator, steps) {
  const active = new Map(segs.map((s) => [s.id, s.form]));
  const altOf = new Map(segs.map((s) => [s.id, s.alt]));
  const minOf = new Map(segs.map((s) => [s.id, s.min]));
  const order = segs.map((s) => s.id);
  const assemble = () =>
    order.filter((id) => active.has(id)).map((id) => active.get(id)).join(separator);
  const shrink = (id, map) => {
    if (active.has(id) && map.get(id)) active.set(id, map.get(id));
  };
  const ops = {
    drop: (id) => () => active.delete(id),
    alt: (id) => () => shrink(id, altOf),
    min: (id) => () => shrink(id, minOf),
    altAll: (ids) => () => ids.forEach((id) => shrink(id, altOf)),
    minAll: (ids) => () => ids.forEach((id) => shrink(id, minOf)),
  };
  for (const step of steps(ops)) {
    if (displayWidth(assemble()) <= width) break;
    step();
  }
  return assemble();
}

export function renderLine({ status, git = {}, counts = {}, width = 120, config }) {
  const ctx = makeCtx(config);
  const { cfg, paint, ascii, pctOf } = ctx;
  const sections = cfg.sections;
  const segs = [];

  if (sections.warnings) {
    const w = warnSegment(status, ctx);
    if (w) segs.push(w);
  }
  if (sections.repo && status.repo?.name) segs.push({ id: 'repo', form: paint(COLORS.dim, status.repo.name) });
  if (sections.branch) {
    const b = branchSegment(status, git, ctx);
    if (b) segs.push(b);
  }
  if (sections.pr && status.pr?.number != null) segs.push({ id: 'pr', form: paint(COLORS.dim, `PR#${status.pr.number}`) });
  if (sections.model && status.model?.name) {
    segs.push({
      id: 'model',
      form: paint(COLORS.label, status.model.name),
      alt: paint(COLORS.label, truncateDisplay(status.model.name, 9, { ascii })),
    });
  }

  const bar = (id, labelText, pct, cells, thresholds) => {
    const lvl = COLORS[barLevel(pct, thresholds)];
    return {
      id,
      form: `${paint(COLORS.label, `${labelText}:`)} ${paint(lvl, `${renderBar(pct, cells, { ascii })} ${pctOf(pct)}`)}`,
      alt: paint(lvl, `${labelText} ${pctOf(pct)}`),
    };
  };
  if (sections.context && status.context?.usedPct != null) {
    segs.push(bar('ctx', 'CTX', status.context.usedPct, cfg.barWidths.context, cfg.thresholds.context));
  }
  if (sections.fiveHour && status.rateLimits?.fiveHour?.pct != null) {
    segs.push(bar('5h', '5h', status.rateLimits.fiveHour.pct, cfg.barWidths.usage, cfg.thresholds.usage));
  }
  if (sections.sevenDay && status.rateLimits?.sevenDay?.pct != null) {
    segs.push(bar('7d', '7d', status.rateLimits.sevenDay.pct, cfg.barWidths.usage, cfg.thresholds.usage));
  }
  if (sections.activity) {
    const a = activitySegment(counts, ctx);
    if (a) segs.push(a);
  }
  if (sections.duration) {
    const dur = formatDuration(status.cost?.durationMs);
    if (dur) segs.push({ id: 'duration', form: paint(COLORS.dim, dur) });
  }

  const line = fit(segs, width, cfg.style.separator, (ops) => [
    ops.drop('pr'),
    ops.drop('repo'),
    ops.drop('duration'),
    ops.altAll(['ctx', '5h', '7d']),
    ops.drop('activity'),
    ops.drop('ctx'),
    ops.drop('7d'),
    ops.alt('branch'),
    ops.alt('model'),
    ops.drop('5h'),
  ]);
  return displayWidth(line) > width ? truncateDisplay(line, width, { ascii }) : line;
}

function renderBlock({ status, git = {}, counts = {}, width = 120, config, now = Date.now(), timeZone }) {
  const ctx = makeCtx(config);
  const { cfg, paint, ascii, pctOf } = ctx;
  const sections = cfg.sections;
  const sep = cfg.style.separator;

  // ---- row 1: identity ----
  const row1Segs = [];
  if (sections.warnings) {
    const w = warnSegment(status, ctx);
    if (w) row1Segs.push(w);
  }
  if (sections.repo && status.repo?.name) row1Segs.push({ id: 'repo', form: paint(COLORS.dim, status.repo.name) });
  if (sections.branch) {
    const b = branchSegment(status, git, ctx);
    if (b) row1Segs.push(b);
  }
  if (sections.pr && status.pr?.number != null) row1Segs.push({ id: 'pr', form: paint(COLORS.dim, `PR#${status.pr.number}`) });
  if (sections.model && status.model?.name) {
    const effort = sections.effort && status.effort ? ` ${paint(COLORS.dim, status.effort)}` : '';
    row1Segs.push({
      id: 'model',
      form: paint(COLORS.label, status.model.name) + effort,
      alt: paint(COLORS.label, truncateDisplay(status.model.name, 9, { ascii })),
    });
  }
  if (sections.duration) {
    const dur = formatDuration(status.cost?.durationMs);
    if (dur) row1Segs.push({ id: 'duration', form: paint(COLORS.dim, dur) });
  }
  if (sections.cost && Number.isFinite(status.cost?.usd)) {
    row1Segs.push({ id: 'cost', form: paint(COLORS.dim, `$${status.cost.usd.toFixed(2)}`) });
  }

  const row1 = fit(row1Segs, width, sep, (ops) => [
    ops.drop('pr'),
    ops.drop('cost'),
    ops.drop('repo'),
    ops.drop('duration'),
    ops.alt('branch'),
    ops.alt('model'),
  ]);

  // ---- row 2: gauges ----
  const row2Segs = [];
  const gauge = (id, labelText, pct, cells, thresholds, extraDim) => {
    const lvl = COLORS[barLevel(pct, thresholds)];
    const extra = extraDim ? ` ${paint(COLORS.dim, extraDim)}` : '';
    return {
      id,
      form:
        `${paint(COLORS.label, labelText)} ${paint(lvl, `${renderBar(pct, cells, { ascii })} ${pctOf(pct)}`)}` + extra,
      alt: `${paint(COLORS.label, labelText)} ${paint(lvl, `${renderBar(pct, cells, { ascii })} ${pctOf(pct)}`)}`,
      min: paint(lvl, `${labelText} ${pctOf(pct)}`),
    };
  };

  if (sections.context && status.context?.usedPct != null) {
    const tok =
      sections.tokens && status.context.totalIn != null && status.context.size != null
        ? `${formatTokens(status.context.totalIn)}/${formatTokens(status.context.size)}`
        : null;
    row2Segs.push(gauge('ctx', 'CTX', status.context.usedPct, cfg.barWidths.blockContext, cfg.thresholds.context, tok));
  }
  const limitGauge = (id, labelText, limit) => {
    const reset = sections.resets ? formatReset(limit.resetsAt, { now, timeZone, ascii }) : null;
    return gauge(id, labelText, limit.pct, cfg.barWidths.blockUsage, cfg.thresholds.usage, reset);
  };
  if (sections.fiveHour && status.rateLimits?.fiveHour?.pct != null) {
    row2Segs.push(limitGauge('5h', '5h', status.rateLimits.fiveHour));
  }
  if (sections.sevenDay && status.rateLimits?.sevenDay?.pct != null) {
    row2Segs.push(limitGauge('7d', '7d', status.rateLimits.sevenDay));
  }
  if (sections.activity) {
    const a = activitySegment(counts, ctx);
    if (a) row2Segs.push(a);
  }

  const rows = [row1];
  if (row2Segs.length) {
    rows.push(
      fit(row2Segs, width, sep, (ops) => [
        ops.altAll(['ctx', '5h', '7d']),
        ops.minAll(['ctx', '5h', '7d']),
        ops.drop('ctx'),
        ops.drop('7d'),
        ops.drop('activity'),
      ])
    );
  }
  return rows.map((r) => (displayWidth(r) > width ? truncateDisplay(r, width, { ascii }) : r));
}

export function renderStatusLines(opts) {
  const layout = opts.config?.style?.layout ?? 'block';
  if (layout === 'line') return [renderLine(opts)];
  return renderBlock(opts);
}
