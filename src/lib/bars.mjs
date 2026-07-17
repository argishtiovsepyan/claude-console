// Usage/context bars. Fill and threshold math intentionally mirrors the
// previous ~/.claude/statusline-command.sh awk formulas so the upgrade
// renders identically for the same inputs.

export function renderBar(pct, width, { ascii = false, fill } = {}) {
  const p = Number.isFinite(Number(pct)) ? Number(pct) : 0;
  const filled = Math.min(width, Math.max(0, Math.floor((p / 100) * width + 0.5)));
  const [full, empty] = ascii ? ['#', '-'] : [fill ?? '█', '░'];
  return full.repeat(filled) + empty.repeat(width - filled);
}

export function barLevel(pct, [warn, crit]) {
  const p = Math.round(Number(pct) || 0);
  if (p >= crit) return 'high';
  if (p >= warn) return 'mid';
  return 'low';
}
