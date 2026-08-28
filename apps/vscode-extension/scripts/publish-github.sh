#!/usr/bin/env bash
set -euo pipefail

# Publish the Praxis .vsix to GitHub Packages' npm registry
# (npm.pkg.github.com), for use by the Frosty GitHub-provider Store/update
# check.
#
# GitHub Packages has no generic-file registry — only npm, Docker/OCI, Maven,
# etc. This script packages the .vsix as the sole file of a throwaway npm
# package and publishes it via `npm publish`. The Frosty GitHub Store/update
# code resolves extension metadata by unzipping the .vsix it downloads, so no
# sidecar files (.json/.svg/.md) are published here.
#
# Auth (first match wins):
#   1. --token argument
#   2. GITHUB_TOKEN / GH_TOKEN
#   3. gh auth token (if the gh CLI is installed and logged in)
#
# The token needs the `write:packages` scope (and `repo` for a private
# package/repo).
#
# Usage:
#   ./scripts/publish-github.sh
#   ./scripts/publish-github.sh --vsix-path artifacts/praxis-0.2.1.vsix

# Colors
CYAN='\033[1;36m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

step() { echo -e "${CYAN}==> $*${NC}"; }
ok()   { echo -e "${GREEN}  + $*${NC}"; }
warn() { echo -e "${YELLOW}  ! $*${NC}"; }

VSIX_PATH=""
TOKEN=""
OWNER="davidacres"
PACKAGE_NAME="praxis"
REPO_NAME="praxis"
HOMEPAGE="https://github.com/davidacres/praxis"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vsix-path|-VsixPath)
      VSIX_PATH="$2"
      shift 2
      ;;
    --token|-Token)
      TOKEN="$2"
      shift 2
      ;;
    --owner|-Owner)
      OWNER="$2"
      shift 2
      ;;
    --package-name|-PackageName)
      PACKAGE_NAME="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$EXT_ROOT"

resolve_github_token() {
  local explicit="$1"
  if [ -n "$explicit" ]; then
    echo "$explicit"
    return
  fi
  for key in GITHUB_TOKEN GH_TOKEN; do
    val="${!key:-}"
    if [ -n "$val" ]; then
      echo "$val"
      return
    fi
  done
  if command -v gh >/dev/null 2>&1; then
    local from_gh
    from_gh=$(gh auth token 2>/dev/null || true)
    if [ -n "$from_gh" ]; then
      echo "$from_gh"
      return
    fi
  fi
  return 1
}

resolve_owner() {
  local explicit="$1"
  if [ -n "$explicit" ]; then
    echo "$explicit"
    return
  fi
  local origin
  origin=$(git remote get-url origin 2>/dev/null || true)
  if [[ "$origin" =~ ^git@github\.com:([^/]+)/ ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  elif [[ "$origin" =~ ^https?://github\.com/([^/]+)/ ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi
  return 1
}

# Find VSIX if not provided
if [ -z "$VSIX_PATH" ]; then
  VSIX_PATH=$(ls -t artifacts/"$PACKAGE_NAME"-*.vsix 2>/dev/null | head -n1 || true)
fi
if [ -z "$VSIX_PATH" ] || [ ! -f "$VSIX_PATH" ]; then
  echo "No artifacts/$PACKAGE_NAME-*.vsix found. Run: npm run build" >&2
  exit 1
fi
VSIX_PATH=$(cd "$(dirname "$VSIX_PATH")" && pwd)/$(basename "$VSIX_PATH")

FILE_NAME=$(basename "$VSIX_PATH")
# Extract version: praxis[-preview]-<version>.vsix
if [[ ! "$FILE_NAME" =~ ^$PACKAGE_NAME(-preview)?-(.+)\.vsix$ ]]; then
  echo "Unexpected VSIX name '$FILE_NAME' (expected $PACKAGE_NAME[-preview]-<version>.vsix)." >&2
  exit 1
fi
VERSION="${BASH_REMATCH[2]}"

TOKEN=$(resolve_github_token "$TOKEN") || {
  cat >&2 <<EOF
No GitHub token found. Set one of:
  --token <pat>
  \$GITHUB_TOKEN / \$GH_TOKEN  (personal access token with write:packages scope)
  gh auth login                (then this script reads it via 'gh auth token')
EOF
  exit 1
}

OWNER=$(resolve_owner "$OWNER") || {
  echo "Could not determine the GitHub owner. Pass --owner <org-or-user>." >&2
  exit 1
}

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to publish to GitHub Packages but was not found on PATH." >&2
  exit 1
fi

HOMEPAGE="https://github.com/${OWNER}/${REPO_NAME}"

step "Publishing @${OWNER}/${PACKAGE_NAME}@${VERSION} → GitHub Packages"

STAGE_DIR=$(mktemp -d -t "praxis-publish-github-XXXXXX")
cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

cp "$VSIX_PATH" "$STAGE_DIR/$FILE_NAME"

node -e "
const fs = require('fs');
const path = require('path');
const owner = process.argv[1];
const name = process.argv[2];
const version = process.argv[3];
const fileName = process.argv[4];
const repoName = process.argv[5];
const homepage = process.argv[6];
const pkg = {
  name: '@' + owner + '/' + name,
  version,
  description: 'Praxis VS Code extension .vsix, published for the Frosty GitHub Packages store/update provider.',
  author: owner,
  homepage,
  publishConfig: { registry: 'https://npm.pkg.github.com' },
  files: [fileName],
  repository: { type: 'git', url: 'https://github.com/' + owner + '/' + repoName + '.git' },
};
fs.writeFileSync(path.join(process.argv[7], 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
" "$OWNER" "$PACKAGE_NAME" "$VERSION" "$FILE_NAME" "$REPO_NAME" "$HOMEPAGE" "$STAGE_DIR"

cat > "$STAGE_DIR/.npmrc" <<EOF
@${OWNER}:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${TOKEN}
EOF

(
  cd "$STAGE_DIR"
  npm publish --registry=https://npm.pkg.github.com
)

ok "Published @${OWNER}/${PACKAGE_NAME}@${VERSION} ($FILE_NAME)"
echo
echo -e "${CYAN}View: https://github.com/${OWNER}?tab=packages&repo_name=${REPO_NAME}${NC}"
