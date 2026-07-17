#!/usr/bin/env bash
# One-command installer for claude-console (statusline + HUD).
# Safe to rerun; backs up ~/.claude/settings.json before changing anything.
set -euo pipefail
cd "$(dirname "$0")"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for c in "$HOME/.nvm/versions/node/"*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c"
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "claude-console: node >= 18 is required but was not found on PATH" >&2
  exit 1
fi

exec "$NODE_BIN" src/cli.mjs install "$@"
