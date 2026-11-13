#!/usr/bin/env bash
#
# Build and launch the Praxis desktop (Tauri) app.
#
# Compiles the workspaces in dependency order and starts the native Tauri shell:
#
#   0. npm install            -> only when package-lock.json is newer than the last install
#   1. packages/core, packages/mobile-protocol, packages/mobile-relay -> tsc
#   2. apps/praxis-desktop/renderer -> vite build (or dev server in --dev mode)
#   3. target/debug/praxis-desktop -> cargo build -p praxis-desktop
#   4. praxis-desktop -> opens the native window
#
# In --dev mode the renderer build is replaced by the Vite dev server: the script starts it,
# waits for the port to answer, and points the desktop shell at it through
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
#   ./scripts/run-app.sh --demo       # launch with built-in sample data
#   ./scripts/run-app.sh --dev --port 5174

set -euo pipefail

DEV=0
SKIP_BUILD=0
PORT=5173
DEMO=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev) DEV=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --demo) DEMO=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$REPO_ROOT/packages/core"
MOBILE_PROTOCOL="$REPO_ROOT/packages/mobile-protocol"
MOBILE_RELAY="$REPO_ROOT/packages/mobile-relay"
FRONTEND="$REPO_ROOT/apps/praxis-desktop/renderer"
DESKTOP_BIN="$REPO_ROOT/target/debug/praxis-desktop"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  + %s\033[0m\n' "$1"; }

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

if [[ -z "${PRAXIS_USER_DATA_DIR:-}" ]]; then
  if [[ "$(uname -s)" == "Darwin" && -d "$HOME/Library/Application Support/Praxis" ]]; then
    export PRAXIS_USER_DATA_DIR="$HOME/Library/Application Support/Praxis"
  fi
fi

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

# npm writes node_modules/.package-lock.json at the end of every successful
# install. A lockfile newer than that (or no install at all) means a pull or
# commit changed dependencies; launching anyway fails with "Cannot find module".
# --skip-build is the fast path, so it does not install.
INSTALLED_LOCK="$REPO_ROOT/node_modules/.package-lock.json"
if [[ "$SKIP_BUILD" -eq 0 && ( ! -f "$INSTALLED_LOCK" || "$REPO_ROOT/package-lock.json" -nt "$INSTALLED_LOCK" ) ]]; then
  step 'Dependencies changed; running npm install'
  (cd "$REPO_ROOT" && npm install)
  ok 'node_modules up to date'
fi

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  step 'Skipping build; checking existing output'
  assert_built "$CORE/out/index.js" 'core is not compiled'
  assert_built "$MOBILE_PROTOCOL/out/index.js" 'mobile-protocol is not compiled'
  assert_built "$MOBILE_RELAY/out/index.js" 'mobile-relay is not compiled'
  assert_built "$DESKTOP_BIN" 'desktop-app is not compiled'
  if [[ "$DEV" -eq 0 ]]; then
    assert_built "$FRONTEND/dist/index.html" 'frontend is not built'
  fi
  ok 'Existing build output looks complete'
else
  step 'Compiling packages/core'
  invoke_npm "$CORE" compile
  ok 'core -> out/'

  step 'Compiling packages/mobile-protocol and packages/mobile-relay'
  invoke_npm "$MOBILE_PROTOCOL" compile
  invoke_npm "$MOBILE_RELAY" compile
  ok 'mobile packages -> out/'

  if [[ "$DEV" -eq 0 ]]; then
    step 'Building apps/praxis-desktop/renderer'
    invoke_npm "$FRONTEND" build
    ok 'frontend -> dist/'
  fi

  step 'Compiling native Tauri desktop shell'
  (cd "$REPO_ROOT" && cargo build -p praxis-desktop)
  ok 'desktop -> target/debug/praxis-desktop'
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

# macOS resolves application identity and the Dock icon from the enclosing bundle.
# Keep the executable in-process so exit handling and Vite cleanup still work.
if [[ "$(uname -s)" == "Darwin" ]]; then
  step 'Preparing native macOS app bundle'
  DESKTOP_BIN="$(node "$REPO_ROOT/apps/praxis-desktop/scripts/prepare-macos-dev-bundle.cjs" "$DESKTOP_BIN")"

  # Stable signing. Keychain "Always Allow" follows the code-signing identity, and an unsigned rebuild
  # gets a new one every time, so the keychain asks again after every build. The identity used is
  # PRAXIS_DEV_SIGN_IDENTITY if set, else a "Praxis Dev" certificate (scripts/setup-dev-signing.sh),
  # else the first "Apple Development" identity in the keychain. With none of those, or with
  # PRAXIS_DEV_SIGN=0, the bundle is left unsigned as before.
  SIGN_KEYCHAIN=()
  [[ -n "${PRAXIS_DEV_SIGN_KEYCHAIN:-}" ]] && SIGN_KEYCHAIN=("$PRAXIS_DEV_SIGN_KEYCHAIN")
  SIGN_IDENTITIES="$(security find-identity -v -p codesigning ${SIGN_KEYCHAIN[@]:+"${SIGN_KEYCHAIN[@]}"} 2>/dev/null || true)"
  SIGN_IDENTITY="${PRAXIS_DEV_SIGN_IDENTITY:-}"
  if [[ -z "$SIGN_IDENTITY" ]]; then
    if grep -qF '"Praxis Dev"' <<<"$SIGN_IDENTITIES"; then
      SIGN_IDENTITY="Praxis Dev"
    else
      SIGN_IDENTITY="$(sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' <<<"$SIGN_IDENTITIES" | head -n 1)"
    fi
  fi
  if [[ "${PRAXIS_DEV_SIGN:-1}" != "0" && -n "$SIGN_IDENTITY" ]] && grep -qF "\"$SIGN_IDENTITY\"" <<<"$SIGN_IDENTITIES"; then
    APP_BUNDLE="$(cd "$(dirname "$DESKTOP_BIN")/../.." && pwd)"
    BUNDLE_ID="$(node -p "require('$REPO_ROOT/apps/praxis-desktop/src-tauri/tauri.conf.json').identifier")"
    if codesign --force --sign "$SIGN_IDENTITY" ${SIGN_KEYCHAIN[@]:+--keychain "${SIGN_KEYCHAIN[0]}"} --identifier "$BUNDLE_ID" "$APP_BUNDLE" >/dev/null 2>&1; then
      ok "Signed dev bundle as \"$SIGN_IDENTITY\" ($BUNDLE_ID)"
    else
      printf '\033[33m  ! Could not sign with "%s"; launching unsigned\033[0m\n' "$SIGN_IDENTITY"
    fi
  fi
fi

step 'Launching Praxis Desktop (Tauri)'
if [[ "$DEMO" -eq 1 ]]; then
  "$DESKTOP_BIN" --demo || EXIT_CODE=$?
else
  "$DESKTOP_BIN" || EXIT_CODE=$?
fi

if [[ "$EXIT_CODE" -ne 0 ]]; then
  printf '\033[33mPraxis Desktop exited with code %s\033[0m\n' "$EXIT_CODE"
  exit "$EXIT_CODE"
fi

ok 'App closed'
