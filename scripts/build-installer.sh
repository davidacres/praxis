#!/usr/bin/env bash
# Build the Praxis app, then package it with electron-builder.
set -euo pipefail

TARGET="native"
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Usage: ./scripts/build-installer.sh [options]

Options:
  --target <target>   Packaging target:
                        native   - default target for current OS
                        mac|dmg  - macOS DMG (.dmg)
                        win|nsis - Windows NSIS setup (.exe)
                        linux    - Linux AppImage & Debian package (.AppImage, .deb)
                        appimage - Linux AppImage (.AppImage)
                        deb      - Debian / Ubuntu package (.deb)
                        dir      - Unpacked directory (quick verification)
  --skip-build        Skip rebuilding core, renderer, and desktop before packaging
  --help, -h          Show this help message

Examples:
  ./scripts/build-installer.sh --target mac
  ./scripts/build-installer.sh --target linux
  ./scripts/build-installer.sh --target win
  ./scripts/build-installer.sh --target appimage
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --help|-h) usage ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_BIN="$REPO_ROOT/target/debug/praxis-desktop"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  "$SCRIPT_DIR/build-app.sh"
else
  for required in "$REPO_ROOT/packages/core/out/index.js" "$REPO_ROOT/apps/praxis-desktop/renderer/dist/index.html" "$DESKTOP_BIN"; do
    [[ -f "$required" ]] || { echo "Missing build input: $required" >&2; exit 1; }
  done
fi

printf '\033[36m==> Packaging Praxis (%s) via Tauri\033[0m\n' "$TARGET"
node "$REPO_ROOT/scripts/bundle-code-intelligence.mjs"
(cd "$REPO_ROOT/apps/praxis-desktop/renderer" && npm run tauri:build)

printf '\033[32m  + Distribution artifacts are ready in target/debug\033[0m\n'
