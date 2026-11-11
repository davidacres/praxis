#!/usr/bin/env bash
# Builds/tests the Rust workspace from an agent worktree without a second 20 GB target dir.
#
# Dependencies are compiled once in the main checkout's target dir and shared; only this
# worktree's own crates rebuild. Cargo builds are serialised by a lock, and the resulting binary is
# copied to ./.agent-bin/praxis-desktop immediately so concurrent agents never run each other's.
#
#   scripts/agent-build.sh build            # cargo build -p praxis-desktop, then copy the binary
#   scripts/agent-build.sh test -p praxis-ai --lib foo     # any other cargo subcommand, serialised
# Run specs against your own binary:
#   PRAXIS_TAURI_BIN=$PWD/.agent-bin/praxis-desktop PRAXIS_E2E_PORT=<your port> npx playwright test ...
set -euo pipefail
MAIN="${PRAXIS_MAIN_CHECKOUT:-/Users/daveacres/dev/tools/praxis}"
LOCK=/tmp/praxis-agent-build.lock
export CARGO_TARGET_DIR="$MAIN/target" CARGO_INCREMENTAL=0 PATH="$HOME/.cargo/bin:$PATH"
until mkdir "$LOCK" 2>/dev/null; do sleep 2; done
trap 'rmdir "$LOCK"' EXIT
sub="${1:-build}"; shift || true
if [ "$sub" = build ]; then
  cargo build -p praxis-desktop "$@"
  mkdir -p .agent-bin && cp "$CARGO_TARGET_DIR/debug/praxis-desktop" .agent-bin/praxis-desktop
  echo "binary: $PWD/.agent-bin/praxis-desktop"
else
  cargo "$sub" "$@"
fi
