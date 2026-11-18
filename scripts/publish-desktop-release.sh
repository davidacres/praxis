#!/usr/bin/env bash
# Create or update a GitHub Release from installers built by scripts/package-desktop.mjs.
set -euo pipefail

TAG=""
PRERELEASE=0
DRAFT=0

usage() {
  cat <<'EOT'
Usage: ./scripts/publish-desktop-release.sh [options]

Uploads everything in dist/release/ (run `npm run release:package` first, once per
platform) to the GitHub Release for the desktop version.

Options:
  --tag <vX.Y.Z>   Release tag (default: v<version in tauri.conf.json>)
  --prerelease     Mark a newly created release as a prerelease
  --draft          Create a draft release
  --help, -h       Show this help

Requires an authenticated GitHub CLI (`gh auth login`). Safe to rerun: an existing
release is reused and matching assets are replaced.
EOT
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --prerelease) PRERELEASE=1; shift ;;
    --draft) DRAFT=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO_ROOT/dist/release"
VERSION="$(node -p "require('$REPO_ROOT/apps/praxis-desktop/src-tauri/tauri.conf.json').version")"
[[ -n "$TAG" ]] || TAG="v$VERSION"
[[ "$TAG" == "v$VERSION" ]] || { echo "Tag $TAG does not match desktop version $VERSION." >&2; exit 1; }

command -v gh >/dev/null || { echo 'GitHub CLI is required: https://cli.github.com/' >&2; exit 1; }
gh auth status >/dev/null

shopt -s nullglob
artifacts=("$DIST"/Praxis_"$VERSION"_*)
[[ "${#artifacts[@]}" -gt 0 ]] || { echo "No Praxis_${VERSION}_* installers in $DIST. Run npm run release:package first." >&2; exit 1; }

if ! gh release view "$TAG" >/dev/null 2>&1; then
  create_args=("$TAG" --title "Release $TAG" --generate-notes)
  [[ "$PRERELEASE" -eq 1 ]] && create_args+=(--prerelease)
  [[ "$DRAFT" -eq 1 ]] && create_args+=(--draft)
  gh release create "${create_args[@]}"
fi

gh release upload "$TAG" --clobber "${artifacts[@]}"
printf 'Published %d artifact(s) to release %s.\n' "${#artifacts[@]}" "$TAG"
