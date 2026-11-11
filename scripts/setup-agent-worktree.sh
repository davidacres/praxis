#!/usr/bin/env bash
# Prepares a fresh git worktree of this repo so it can build and run the e2e specs.
# Untracked build inputs (node_modules, packages/core/out, renderer/dist) are shared from the main
# checkout: node_modules by symlink, the built outputs by copy. Usage:
#   scripts/setup-agent-worktree.sh /path/to/main/checkout     (run from inside the worktree)
set -euo pipefail
MAIN="${1:?path to the main checkout}"
HERE="$(pwd)"
[ "$MAIN" != "$HERE" ] || { echo "run this from inside the worktree, not the main checkout" >&2; exit 1; }
while IFS= read -r dir; do
  rel="${dir#"$MAIN"/}"
  mkdir -p "$(dirname "$HERE/$rel")"
  [ -e "$HERE/$rel" ] || ln -s "$dir" "$HERE/$rel"
done < <(find "$MAIN" -maxdepth 4 -name node_modules -type d -prune -not -path "*/target/*" -not -path "*/node_modules/*")
for rel in packages/core/out apps/praxis-desktop/renderer/dist; do
  if [ -d "$MAIN/$rel" ] && [ ! -d "$HERE/$rel" ]; then mkdir -p "$(dirname "$HERE/$rel")"; cp -R "$MAIN/$rel" "$HERE/$rel"; fi
done
echo "worktree ready: node_modules linked, core/out and renderer/dist copied"
