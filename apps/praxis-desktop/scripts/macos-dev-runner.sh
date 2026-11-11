#!/bin/bash
# Runner for `tauri dev` on macOS (see run-tauri.cjs): the bare cargo binary has no
# Info.plist, so the Dock shows a generic icon. Wrap it in Praxis.app first, then
# launch the bundled executable so NSBundle resolves the real icon.
set -euo pipefail
binary="$1"
shift
bundled="$(node "$(dirname "$0")/prepare-macos-dev-bundle.cjs" "$binary")"
exec "$bundled" "$@"
