#!/usr/bin/env bash
# Create or update a GitHub Release from locally built desktop artifacts.
set -euo pipefail

TARGET="native"
TAG=""
PRERELEASE=0
DRAFT=0

usage() {
  cat <<'EOF'
Usage: ./scripts/publish-desktop-release.sh [options]

Options:
  --target <mac|win|linux>  Artifacts to upload (default: current OS)
  --tag <vX.Y.Z>           Release tag (default: desktop package version)
  --prerelease             Mark a newly created release as a prerelease
  --draft                  Create a draft release
  --help, -h               Show this help

Requires an authenticated GitHub CLI (`gh auth login`). Existing releases are
updated and matching assets are replaced, making the command safe to rerun.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --prerelease) PRERELEASE=1; shift ;;
    --draft) DRAFT=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO_ROOT/apps/praxis-desktop/main/dist"
VERSION="$(node -p "require('$REPO_ROOT/apps/praxis-desktop/main/package.json').version")"
[[ -n "$TAG" ]] || TAG="v$VERSION"
[[ "$TAG" == "v$VERSION" ]] || { echo "Tag $TAG does not match desktop version $VERSION." >&2; exit 1; }

if [[ "$TARGET" == "native" ]]; then
  case "$(uname -s)" in
    Darwin) TARGET="mac" ;;
    Linux) TARGET="linux" ;;
    *) echo 'Use --target win from Windows Git Bash, WSL, or another shell.' >&2; exit 1 ;;
  esac
fi

command -v gh >/dev/null || { echo 'GitHub CLI is required: https://cli.github.com/' >&2; exit 1; }
gh auth status >/dev/null

shopt -s nullglob
case "$TARGET" in
  mac)
    installers=("$DIST"/Praxis-"$VERSION"-*.dmg)
    updater_archives=("$DIST"/Praxis-"$VERSION"-*.zip)
    [[ "${#installers[@]}" -gt 0 && "${#updater_archives[@]}" -gt 0 && -f "$DIST/latest-mac.yml" ]] || {
      echo "A DMG, updater ZIP, and latest-mac.yml are required in $DIST." >&2
      exit 1
    }
    artifacts=("${installers[@]}" "$DIST"/Praxis-"$VERSION"-*.dmg.blockmap "${updater_archives[@]}" "$DIST"/Praxis-"$VERSION"-*.zip.blockmap "$DIST"/latest-mac.yml)
    ;;
  win|windows)
    [[ -f "$DIST/Praxis-$VERSION-setup.exe" && -f "$DIST/latest.yml" ]] || {
      echo "The NSIS installer and latest.yml are required in $DIST." >&2
      exit 1
    }
    artifacts=("$DIST/Praxis-$VERSION-setup.exe" "$DIST"/Praxis-"$VERSION"-setup.exe.blockmap "$DIST/latest.yml")
    ;;
  linux)
    appimages=("$DIST"/Praxis-"$VERSION"-*.AppImage)
    debs=("$DIST"/Praxis-"$VERSION"-*.deb)
    [[ "${#appimages[@]}" -gt 0 && "${#debs[@]}" -gt 0 && -f "$DIST/latest-linux.yml" ]] || {
      echo "An AppImage, Debian package, and latest-linux.yml are required in $DIST." >&2
      exit 1
    }
    artifacts=("${appimages[@]}" "${debs[@]}" "$DIST/latest-linux.yml")
    ;;
  *) echo "Unsupported target: $TARGET (use mac, win, or linux)" >&2; exit 1 ;;
esac

if ! gh release view "$TAG" --repo davidacres/praxis >/dev/null 2>&1; then
  create_args=("$TAG" --repo davidacres/praxis --title "Release $TAG" --generate-notes)
  [[ "$PRERELEASE" -eq 1 ]] && create_args+=(--prerelease)
  [[ "$DRAFT" -eq 1 ]] && create_args+=(--draft)
  gh release create "${create_args[@]}"
fi

gh release upload "$TAG" --repo davidacres/praxis --clobber "${artifacts[@]}"
printf 'Published %s desktop artifacts to release %s.\n' "$TARGET" "$TAG"
