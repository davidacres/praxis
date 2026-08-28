#!/usr/bin/env bash
# Build the Praxis app, then package it with electron-builder.
set -euo pipefail

TARGET="native"
SKIP_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ELECTRON_APP="$REPO_ROOT/apps/praxis-desktop/main"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  "$SCRIPT_DIR/build-app.sh"
else
  for required in "$REPO_ROOT/packages/core/out/index.js" "$REPO_ROOT/apps/praxis-desktop/renderer/dist/index.html" "$ELECTRON_APP/out/main/index.js" "$ELECTRON_APP/renderer/index.html"; do
    [[ -f "$required" ]] || { echo "Missing build input: $required" >&2; exit 1; }
  done
fi

case "$TARGET" in
  native) builder_args=() ;;
  mac|dmg) builder_args=(--mac dmg) ;;
  win|windows|nsis) builder_args=(--win nsis) ;;
  dir) builder_args=(--dir) ;;
  *) echo "Unsupported target: $TARGET (use native, mac, win, or dir)" >&2; exit 1 ;;
esac

printf '\033[36m==> Packaging Praxis (%s)\033[0m\n' "$TARGET"
(cd "$ELECTRON_APP" && npx electron-builder ${builder_args[@]+"${builder_args[@]}"} --publish never)

printf '\033[32m  + Installer artifacts are ready:\033[0m\n'
find "$ELECTRON_APP/dist" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.exe' -o -name '*.AppImage' \) -print
