// HUD configuration: defaults preserve the legacy statusline look exactly
// (colors, thresholds, bar widths, separator). User overrides live in
// <hud dir>/config.json; env vars win over the file.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function defaultConfig() {
  return {
    style: {
      ascii: false,
      color: true,
      separator: ' | ',
      // 'block' = two rows (identity + gauges); 'line' = legacy single row
      layout: 'block',
    },
    thresholds: {
      // [yellow, red] — same values as the legacy script
      context: [50, 75],
      usage: [70, 90],
      // leading ⚠ markers appear at these levels
      usageAlert: 95,
      contextAlert: 90,
    },
    barWidths: {
      context: 10,
      usage: 7,
      blockContext: 14,
      blockUsage: 12,
    },
    sections: {
      warnings: true,
      repo: true,
      branch: true,
      pr: true,
      model: true,
      effort: true,
      context: true,
      fiveHour: true,
      sevenDay: true,
      activity: true,
      duration: true,
      cost: true,
      tokens: true,
      resets: true,
    },
    statusline: {
      // 'hud' = the full session HUD renders inside Claude Code, per tab
      // (the final design); 'block' = compact two rows; with mode 'block',
      // style.layout 'line' gives the legacy single row
      mode: 'hud',
    },
    hud: {
      // 'columns' = WHO/WHERE/LIMITS left, AGENTS/WORKFLOWS/SHELLS right
      // (falls back to 'stack' automatically under 84 cols)
      layout: 'columns',
      gutter: 'space', // 'space' = whitespace between columns; 'bar' = dim │
      rowGap: false, // opt-in: blank spacer row between info rows (WHO/WHERE/LIMITS)
      // claude-console session-view sections (statusline sections are above)
      sections: {
        skills: false,
        failures: false,
      },
    },
    staleness: {
      // session state considered idle/gc-able after these
      idleAfterMs: 120_000,
      gcAfterMs: 6 * 3600_000,
      gcEveryMs: 10 * 60_000,
    },
    gitDirtyTtlMs: 10_000,
    watchIntervalMs: 2_000,
    fallbackWidth: 120,
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(hudDir, env = process.env) {
  let user = {};
  try {
    const parsed = JSON.parse(readFileSync(join(hudDir, 'config.json'), 'utf8'));
    if (isPlainObject(parsed)) user = parsed;
  } catch {
    // missing or invalid config -> defaults
  }
  const cfg = deepMerge(defaultConfig(), user);
  if (env.CLAUDE_HUD_ASCII === '1' || env.CLAUDE_HUD_ASCII === 'true') cfg.style.ascii = true;
  if (env.NO_COLOR !== undefined) cfg.style.color = false; // NO_COLOR spec: any value (incl. empty) disables color
  return cfg;
}
