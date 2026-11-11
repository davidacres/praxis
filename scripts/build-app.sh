#!/usr/bin/env bash
# Build the Praxis desktop app on macOS or Linux.
set -euo pipefail

SKIP_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$REPO_ROOT/packages/core"
FRONTEND="$REPO_ROOT/apps/praxis-desktop/renderer"
DESKTOP_BIN="$REPO_ROOT/target/debug/praxis-desktop"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok() { printf '\033[32m  + %s\033[0m\n' "$1"; }
invoke_npm() { (cd "$1" && npm run "$2"); }

export NODE_OPTIONS=

# Ensure cargo / rustup is available on PATH if installed in standard locations
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck source=/dev/null
    source "$HOME/.cargo/env"
  elif [[ -d "$HOME/.cargo/bin" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Error: 'cargo' was not found on PATH." >&2
  echo "Please ensure the Rust toolchain is installed (e.g. via rustup: https://rustup.rs) and ~/.cargo/bin is in your PATH." >&2
  exit 1
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  step 'Compiling shared core'
  invoke_npm "$CORE" compile
  step 'Building the Praxis interface'
  invoke_npm "$FRONTEND" build
  step 'Compiling the native Tauri desktop shell'
  (cd "$REPO_ROOT" && cargo build -p praxis-desktop)
else
  for required in "$CORE/out/index.js" "$FRONTEND/dist/index.html" "$DESKTOP_BIN"; do
    [[ -f "$required" ]] || { echo "Missing build input: $required" >&2; exit 1; }
  done
fi

ok 'Praxis app build is ready.'
printf '  Renderer: %s\n  Desktop:  %s\n' "$FRONTEND/dist" "$DESKTOP_BIN"
