# AGENTS.md — claude-console

Claude Code terminal observability: statusline renderer + `claude-console` session
view + installer. **Read `README.md` for architecture, data sources, config,
and commands.** This file holds agent-facing rules only.

## Rules

- **Zero runtime dependencies.** Plain Node ≥ 18 ESM (`.mjs`). Do not add
  packages; `node:test` only. No build step — keep it plain JS.
- **Truthfulness contract:** every rendered value must come from a verified
  source (statusline stdin JSON, `~/.claude` runtime files, `ps`/`lsof`,
  git). Absent data renders `unknown`/`none detected`. Never scrape terminal
  output; never invent values.
- **Redaction is mandatory** on every new rendered surface (commands, labels,
  snippets): route through `src/lib/redact.mjs` and add corpus tests
  (positive + negative) for new patterns. Never display agent prompts — only
  short descriptions. Never read IDE lock `authToken`.
- **The statusline hot path must never fail or block:** exit 0 always,
  sub-second renders (5 s hard kill by Claude Code), no repo locks
  (`--no-optional-locks`), TTL-cache anything slow (git dirty count), atomic
  state writes (tmp + rename) only.
- **Multi-session safety:** one writer per state file; GC only deletes when
  the owning PID is dead AND the file is old. Don't loosen either check.
- **Installer edits `~/.claude/settings.json` surgically:** backup first,
  record the original `statusLine` once, restore byte-identically on
  uninstall/rollback. Touch no other keys, no shell rc files by default.
- **Process matching:** a claude CLI is argv[0] basename `claude` — plain
  `grep -i claude` false-positives on `.claude/worktrees/...` paths in argv.
- **User-locked display decisions** (owner: argishtiovsepyan): the
  STATUSLINE ITSELF renders the full session HUD inside every Claude Code
  tab (`statusline.mode` defaults to `'hud'`; compact `'block'`/`'line'`
  stay config-only) — each tab shows the final design relative to ITS OWN
  session. `claude-console` shows the same view on demand — one display per
  session regardless of main-checkout vs worktree (machine-wide is `--all`).
  Default layout: 5-WAY GRID at ≥168 cols — rail · SHELLS · WORKFLOWS ·
  AGENTS · gauges (this column order is user-picked); grid3 at 124–167;
  two columns at 84–123; stack below (config `hud.layout`; `hud.gutter`
  defaults to whitespace — the dim │ bar is opt-in). Live-kind glyphs are
  👾 agents · 🚀 workflows · $ shells (user-picked; only width-2 emoji —
  check `displayWidth`). Each grid5 live column shows at most 6 rows; the
  7th (LOCAL's row) is reserved for `+N more`. Counts hug their labels
  (`AGENTS    2 running`) with a breathing row before the detail rows.
  Agent rows: description first, model (cyan) after, then age — the model
  is what the agent ACTUALLY runs (meta → its own transcript → launch
  input). Workflow rows: name + cyan done/total hugging it (NO progress
  bar) + age. Shells are ONE row each ($ purpose · age; the raw command
  never renders). REMOTE + LOCAL sit attached closing the rail; LOCAL
  middle-truncates keeping only the root prefix (`~/…`) so the trailing
  dirs get the room. Gauges: CONTEXT top; 5-HOUR and 7-DAY gather at the
  bottom with ONE breathing row between, 7-DAY landing on the LOCAL row.
  Statusline rows carry a braille leading guard (U+2800) because Claude
  Code trims leading whitespace per row — never remove it. EFFORT shows
  the REAL session level: the /effort confirmation in the transcript
  (genuine user records only) overrides the stdin's base 'xhigh' when
  ultracode is active; ultracode paints Claude-purple (38;5;141). Fixed
  label rail; NO title banner; NO horizontal rule lines; NO PR row; WHERE
  labels are `WORKSPACE` (golden `main terminal` | orange `worktree ·` +
  name) / `BRANCH` / `LOCAL` / `REMOTE`; branch dirt is compact
  statusline-style (`develop +4`, never "uncommitted files");
  skills/failures sections default OFF; no dollar cost and no duration in
  WHO. Only LIVE items render — finished/idle/completed never get rows.
  Don't revert these without the user.
- Statusline stdin schema is version-sensitive (verified on 2.1.206; fixture
  in `test/fixtures/stdin-sample.json`). Parse defensively — every field
  optional. If a new Claude Code version adds/renames fields, extend
  `status.mjs` + fixture, never assume.

## Validation

`npm test` must stay green. For manual smoke:
`node src/cli.mjs install` into a sandbox `HOME`, then `verify` and `doctor`
(see `test/installer.test.mjs` for the pattern).
