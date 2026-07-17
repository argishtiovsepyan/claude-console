# claude-console

Terminal observability for Claude Code: **the full session HUD renders inside
every Claude Code tab** — always visible under the input box, built from that
tab's own session. Five columns at ≥168 cols — labeled rail · SHELLS ·
WORKFLOWS · AGENTS · CONTEXT/5-HOUR/7-DAY gauges — each live kind with its own
glyph (`$` · 🚀 · 👾), up to 6 rows per live column with `+N more` overflow,
REMOTE + LOCAL closing the rail (long paths keep `~/…` + the trailing dirs).
Narrower panes fold to three columns, then two, then a stack. Plus the
identical view on demand via **`claude-console`**, and a **one-command installer**
with full lifecycle (install / update / verify / doctor / rollback /
uninstall). Six tabs = six independent HUDs. Zero runtime dependencies —
plain Node ≥ 18. Compact two-row and single-line statusline modes remain
available via config (`statusline.mode: "block" | "line"`).

## Install

```bash
./install.sh                    # from a repo checkout (or a copied folder)
```

What it does (and reports): copies the app to `~/.claude/hud/app/`, writes
shims to `~/.claude/hud/bin/`, **backs up `~/.claude/settings.json`**, records
your previous `statusLine` value once in
`~/.claude/hud/original-statusline.json`, points `statusLine` at the shim, and
symlinks `~/.local/bin/claude-console` if that directory exists. Nothing else in
settings is touched; rerunning is safe (idempotent). Nothing renders in plain
terminals — the status block only exists inside Claude Code sessions.

## Commands

```bash
claude-console                 # deep view of the session you're in
claude-console --all           # one line per session on this machine (secondary)
claude-console --watch [-n s]  # live refresh; Ctrl-C exits
claude-console --json          # machine-readable session data
claude-console --session <id>  # explicit session (id prefix ok)
claude-console --ascii         # pure-ASCII output; NO_COLOR / --no-color disable ANSI

claude-console update          # refresh the installed copy from this folder
claude-console verify          # checksums + settings wiring + live render test
claude-console doctor          # environment & data-source health, render-time stats
claude-console rollback        # restore the most recent settings backup
claude-console uninstall       # restore the pre-install statusline (--purge removes ~/.claude/hud)
```

Session picking for the default view: `--session` → `$CLAUDE_CODE_SESSION_ID`
(set inside Claude's shells) → the session whose cwd contains your pwd →
most-recent alive session.

## Architecture

```
src/statusline.mjs   # statusline entry: stdin JSON -> 1-2 rows on stdout;
                     # persists per-session state atomically; opportunistic GC
src/cli.mjs          # claude-console entry: views + installer subcommands
src/lib/
  status.mjs         # defensive parser for the statusline stdin payload
  segments.mjs       # width-aware segment engine (block + line layouts)
  hud.mjs            # deep session view (WHO/WHERE/LIMITS/AGENTS/...) + pickSession
  transcript.mjs     # readers over ~/.claude/projects transcripts (agents,
                     # workflows, in-flight shells + purposes, failures, skills)
  runtime.mjs        # ~/.claude/sessions registry reader + source merger
  procs.mjs          # ps/lsof scanning (strict argv0 match — '.claude' paths
                     # in argv are NOT claude processes)
  gitinfo.mjs        # branch/dirty/worktree via --no-optional-locks, timeouts
  state.mjs          # atomic per-session state store + stale GC
  redact.mjs         # central deny-first redaction (see Security)
  ansi.mjs bars.mjs  # ANSI-safe width math, truncation, gauges
  config.mjs         # defaults + ~/.claude/hud/config.json + env overrides
  installer.mjs      # install/verify/rollback/uninstall/doctor
```

## Data sources (all verified on Claude Code 2.1.206)

| Data | Source |
|---|---|
| Model, effort, session name/id, cwd, repo, PR, worktree | statusline stdin JSON (piped by Claude Code per render) |
| Context %, token detail, window size | stdin `context_window` |
| 5h/7d usage + reset times | stdin `rate_limits` (native — no API calls) |
| Terminal width | `COLUMNS`/`LINES` env set by Claude Code |
| Claude PID | statusline process PPID (verified parent chain) |
| Live sessions + busy/idle | `~/.claude/sessions/<pid>.json` registry ∪ HUD state files |
| Agents | `<session dir>/subagents/agent-*.jsonl` + `.meta.json` + parent-transcript Agent tool events |
| Workflows + progress | `<session dir>/workflows/wf_*.json` |
| Running shells + purposes | in-flight Bash `tool_use` records (command + description) |
| Branch / dirty / worktree | `git -C <cwd>` (dirty count TTL-cached in state) |

No terminal-output scraping anywhere. Absent data renders as `unknown` /
`none detected` — never invented.

## Configuration — `~/.claude/hud/config.json`

Deep-merged over defaults; env `CLAUDE_HUD_ASCII=1` and `NO_COLOR` win.

```jsonc
{
  "statusline": { "mode": "hud" },         // "block" = compact rows; +style.layout "line" = single row
  "style": { "layout": "block" },
  "sections": { "activity": true, "cost": true /* block-mode sections */ },
  "hud": { "sections": { "skills": false, "failures": false } }, // claude-console sections
  "thresholds": { "usage": [70, 90], "context": [50, 75] },
  "gitDirtyTtlMs": 10000
}
```

`CLAUDE_HUD_DIR` relocates the state/config dir (used by tests);
`CLAUDE_HUD_NO_PS=1` skips process counting.

## Security

- Central `redact.mjs` runs over every rendered command, label and snippet:
  known token prefixes (`sk-ant-`, `ghp_`, `xox*`, `AKIA…`, JWTs, …),
  `Authorization`/`Cookie` headers, sensitive `key=value` pairs and CLI flags,
  URL passwords and query secrets, high-entropy blobs. Negative-tested so
  SHAs, UUIDs and paths survive.
- Agent prompts are never displayed — only short descriptions (test-enforced).
- IDE lock files contain an `authToken` — never read for display.
- State files contain no secrets (session metadata + numbers only).

## Performance

Measured on a large monorepo with 6 concurrent sessions: first render
124–257 ms (cold git status), steady-state ≈ 63 ms avg — the statusline
budget is 5 s with a 300 ms debounce. `claude-console doctor` reports live
p50/p95 from actual renders on your machine.

## Limitations (honest by design)

- **Blocked-on-permission state** is not exposed by Claude Code without hooks;
  the HUD never claims it. (A future opt-in Notification hook could add it.)
- **Per-agent token spend** is not rolled up anywhere on disk — not shown.
- Agent liveness for non-async agents is inferred from completion records +
  file activity; label is `running`/`done`/`idle`, never a guess beyond that.
- Remote/cloud sessions and other OS users' sessions are out of scope.

## Troubleshooting

- `claude-console doctor` — first stop: shows node, settings wiring, registry and
  state counts, render times, redaction self-test.
- Status line vanished? `claude-console verify`; worst case `claude-console rollback`
  or `claude-console uninstall` (restores your previous statusline exactly).
- Changes to settings hot-reload on your next interaction with Claude Code.

## Tests

```bash
npm test   # 208 tests, node:test, no deps
```
