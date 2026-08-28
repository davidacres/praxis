#!/usr/bin/env bash
#
# Build and launch the Praxis desktop (Electron) app.
#
# Compiles the three workspaces in dependency order and starts Electron:
#
#   1. packages/core          -> tsc, produces out/ that the main process imports
#   2. apps/praxis-desktop/renderer      -> vite build, produces dist/ that the window loads
#   3. apps/praxis-desktop/main  -> tsc, produces out/main + out/preload
#   4. copy-renderer          -> apps/praxis-desktop/renderer/dist -> apps/praxis-desktop/main/renderer
#                                 (win.loadFile('../../renderer/index.html') reads from here,
#                                 not from frontend/dist directly — skip this and the window
#                                 opens blank)
#   5. electron .             -> opens the frameless window
#
# In --dev mode step 2/4 are replaced by the Vite dev server: the script starts it,
# waits for the port to answer, and points the main process at it through
# PRAXIS_DEV_SERVER_URL so the renderer hot-reloads on save. The server
# is shut down again when the app window closes.
#
# NODE_OPTIONS is cleared for the child processes. Electron rejects flags such
# as --use-system-ca when they arrive via NODE_OPTIONS and exits with code 9
# before the window ever appears, which is easy to mistake for a build failure.
#
# Usage:
#   ./scripts/run-app.sh              # build + launch
#   ./scripts/run-app.sh --dev        # launch against the Vite dev server (hot reload)
#   ./scripts/run-app.sh --skip-build # launch whatever is already compiled
#   ./scripts/run-app.sh --dev --port 5174

set -euo pipefail

DEV=0
SKIP_BUILD=0
PORT=5173

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev) DEV=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$REPO_ROOT/packages/core"
FRONTEND="$REPO_ROOT/apps/praxis-desktop/renderer"
ELECTRON_APP="$REPO_ROOT/apps/praxis-desktop/main"
NODE_PTY_BINARY="$REPO_ROOT/node_modules/node-pty/build/Release/pty.node"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  + %s\033[0m\n' "$1"; }

# Electron exits 9 on flags it does not accept from NODE_OPTIONS (--use-system-ca
# is the usual culprit in this org's shells), so every child runs without it.
export NODE_OPTIONS=

assert_built() {
  local path="$1" hint="$2"
  if [[ ! -e "$path" ]]; then
    echo "Missing $path — run without --skip-build ($hint)." >&2
    exit 1
  fi
}

invoke_npm() {
  local dir="$1" script="$2"
  (cd "$dir" && npm run "$script")
}

# node-pty's generic macOS prebuild can fail to spawn on newer macOS releases.
# A local source build uses the current SDK and remains N-API compatible with
# both Node and Electron. Only pay the rebuild cost when the artifact is absent.
if [[ "$(uname -s)" == "Darwin" && ! -f "$NODE_PTY_BINARY" ]]; then
  step 'Building the native terminal integration'
  invoke_npm "$ELECTRON_APP" rebuild-terminal
  ok 'node-pty native module ready'
fi

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  step 'Skipping build; checking existing output'
  assert_built "$CORE/out/index.js" 'core is not compiled'
  assert_built "$ELECTRON_APP/out/main/index.js" 'electron-app is not compiled'
  if [[ "$DEV" -eq 0 ]]; then
    assert_built "$FRONTEND/dist/index.html" 'frontend is not built'
    step 'Refreshing renderer/ from frontend/dist'
    invoke_npm "$ELECTRON_APP" copy-renderer
  fi
  ok 'Existing build output looks complete'
else
  step 'Compiling packages/core'
  invoke_npm "$CORE" compile
  ok 'core -> out/'

  if [[ "$DEV" -eq 0 ]]; then
    step 'Building apps/praxis-desktop/renderer'
    invoke_npm "$FRONTEND" build
    ok 'frontend -> dist/'
  fi

  step 'Compiling apps/praxis-desktop/main'
  invoke_npm "$ELECTRON_APP" compile
  ok 'electron-app -> out/'

  if [[ "$DEV" -eq 0 ]]; then
    step 'Copying frontend/dist into electron-app/renderer'
    invoke_npm "$ELECTRON_APP" copy-renderer
    ok 'renderer ready'
  fi
fi

VITE_PID=""

cleanup() {
  if [[ -n "$VITE_PID" ]] && kill -0 "$VITE_PID" 2>/dev/null; then
    step 'Stopping Vite dev server'
    # Only the PID this script started — never a blanket kill by image name.
    kill "$VITE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

EXIT_CODE=0

if [[ "$DEV" -eq 1 ]]; then
  DEV_URL="http://localhost:$PORT"
  step "Starting Vite dev server on $DEV_URL"
  (cd "$FRONTEND" && npm run dev -- --port "$PORT" --strictPort) &
  VITE_PID=$!

  # Poll rather than sleep a fixed amount: a cold Vite start is much slower
  # than a warm one, and guessing wrong shows the user a blank window.
  READY=0
  for _ in $(seq 1 60); do
    sleep 0.5
    if ! kill -0 "$VITE_PID" 2>/dev/null; then
      echo "Vite dev server exited early." >&2
      exit 1
    fi
    if curl -s -o /dev/null --max-time 2 "$DEV_URL"; then
      READY=1
      break
    fi
  done
  if [[ "$READY" -ne 1 ]]; then
    echo "Vite dev server did not answer on $DEV_URL within 30s." >&2
    exit 1
  fi

  ok 'Dev server ready'
  export PRAXIS_DEV_SERVER_URL="$DEV_URL"
else
  unset PRAXIS_DEV_SERVER_URL || true
fi

step 'Launching Electron'
(cd "$ELECTRON_APP" && npx electron .) || EXIT_CODE=$?

if [[ "$EXIT_CODE" -ne 0 ]]; then
  printf '\033[33mElectron exited with code %s\033[0m\n' "$EXIT_CODE"
  exit "$EXIT_CODE"
fi

ok 'App closed'
