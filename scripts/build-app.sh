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
ELECTRON_APP="$REPO_ROOT/apps/praxis-desktop/main"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok() { printf '\033[32m  + %s\033[0m\n' "$1"; }
invoke_npm() { (cd "$1" && npm run "$2"); }

export NODE_OPTIONS=

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  step 'Compiling shared core'
  invoke_npm "$CORE" compile
  step 'Building the Praxis interface'
  invoke_npm "$FRONTEND" build
  step 'Compiling the desktop shell'
  invoke_npm "$ELECTRON_APP" compile
else
  for required in "$CORE/out/index.js" "$FRONTEND/dist/index.html" "$ELECTRON_APP/out/main/index.js"; do
    [[ -f "$required" ]] || { echo "Missing build input: $required" >&2; exit 1; }
  done
fi

step 'Refreshing the desktop renderer'
invoke_npm "$ELECTRON_APP" copy-renderer

ok 'Praxis app build is ready.'
printf '  Renderer: %s\n  Desktop:  %s\n' "$FRONTEND/dist" "$ELECTRON_APP/out"
