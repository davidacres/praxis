#!/bin/bash
# Publishes the mobile-device-testing marketplace skill, which ships a copy of
# this driver. One command does it all:
#
#   ./publish-skill.sh              sync, bump the patch version if needed, publish
#   ./publish-skill.sh --dry-run    everything except the publish
#   ./publish-skill.sh --bump minor bump minor (or major) instead of patch
#   ./publish-skill.sh --version 1.2.0
#
# Token: PRAXIS_MARKETPLACE_TOKEN if set, else the npm.pkg.github.com token in
# ~/.npmrc, else GITHUB_TOKEN. It is checked for `write:packages` before
# publishing; the token itself is never printed.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
SKILL_DIR="$REPO/addons/skills/mobile-device-testing"
REGISTRY=https://npm.pkg.github.com
DRY_RUN=0
BUMP=patch
VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --bump) BUMP="${2:?--bump needs patch, minor or major}"; shift ;;
    --version) VERSION="${2:?--version needs x.y.z}"; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done
cd "$REPO"
step() { printf '\n▸ %s\n' "$1"; }

# --- token -------------------------------------------------------------------
step "Choosing a token"
TOKEN_SOURCE=""
if [ -n "${PRAXIS_MARKETPLACE_TOKEN:-}" ]; then
  TOKEN="$PRAXIS_MARKETPLACE_TOKEN"; TOKEN_SOURCE="PRAXIS_MARKETPLACE_TOKEN"
else
  TOKEN=$(sed -nE 's#^//npm\.pkg\.github\.com/:_authToken=(.*)$#\1#p' "$HOME/.npmrc" 2>/dev/null | head -1 || true)
  if [ -n "$TOKEN" ]; then
    TOKEN_SOURCE="~/.npmrc"
  elif [ -n "${GITHUB_TOKEN:-}" ]; then
    TOKEN="$GITHUB_TOKEN"; TOKEN_SOURCE="GITHUB_TOKEN"
  fi
fi
[ -n "${TOKEN:-}" ] || { echo "No token found. Set PRAXIS_MARKETPLACE_TOKEN or add //npm.pkg.github.com/:_authToken=… to ~/.npmrc." >&2; exit 1; }
SCOPES=$(curl -sI -H "Authorization: token $TOKEN" https://api.github.com/user | tr -d '\r' | sed -nE 's/^[Xx]-[Oo][Aa]uth-[Ss]copes: (.*)$/\1/p')
if ! printf '%s' "$SCOPES" | grep -q 'write:packages'; then
  echo "The token from $TOKEN_SOURCE lacks write:packages (scopes: ${SCOPES:-none reported})." >&2
  echo "Use a token with write:packages via PRAXIS_MARKETPLACE_TOKEN or ~/.npmrc." >&2
  exit 1
fi
echo "Using the token from $TOKEN_SOURCE (has write:packages)."
export PRAXIS_MARKETPLACE_TOKEN="$TOKEN"

# --- build + sync --------------------------------------------------------------
step "Building core (for manifest and skill validation)"
npm run build:core > /dev/null

step "Syncing the driver into the skill and validating it"
node scripts/build-skill-addons.mjs

# --- version -------------------------------------------------------------------
PACKAGE=$(node -p "require('$SKILL_DIR/package.json').name")
LOCAL=$(node -p "require('$SKILL_DIR/package.json').version")
NPMRC=$(mktemp); chmod 600 "$NPMRC"; trap 'rm -f "$NPMRC"' EXIT
printf '//npm.pkg.github.com/:_authToken=%s\n@davidacres:registry=%s\n' "$TOKEN" "$REGISTRY" > "$NPMRC"
# From a neutral directory: the repo's own .npmrc holds a different registry
# token and npm would prefer it over --userconfig.
PUBLISHED=$(cd "$(dirname "$NPMRC")" && npm view "$PACKAGE" version --registry "$REGISTRY" --userconfig "$NPMRC" 2>/dev/null || true)
step "Version: local $LOCAL, published ${PUBLISHED:-none}"
if [ -n "$VERSION" ]; then
  NEXT="$VERSION"
elif [ -n "$PUBLISHED" ] && [ "$(printf '%s\n%s\n' "$LOCAL" "$PUBLISHED" | sort -V | tail -1)" = "$PUBLISHED" ]; then
  NEXT=$(node -e "const [a,b,c]='$PUBLISHED'.split('.').map(Number);const k='$BUMP';console.log(k==='major'?[a+1,0,0].join('.'):k==='minor'?[a,b+1,0].join('.'):[a,b,c+1].join('.'))")
else
  NEXT="$LOCAL"
fi
if [ "$NEXT" != "$LOCAL" ] && [ "$DRY_RUN" = 1 ]; then
  echo "Would publish $NEXT (files left unchanged in a dry run)."
elif [ "$NEXT" != "$LOCAL" ]; then
  node -e "
    const fs = require('fs'); const file = '$SKILL_DIR/package.json';
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.version = '$NEXT'; pkg.praxis.contentVersion = '$NEXT';
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');"
  sed -i '' -E "s/^version: .*/version: $NEXT/" "$SKILL_DIR/addon/SKILL.md"
  echo "Bumped to $NEXT (package.json, contentVersion, SKILL.md)."
fi

# --- publish -----------------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  step "Dry run"
  node scripts/publish-addon.mjs --dry-run "$SKILL_DIR"
  echo "Nothing was published or changed beyond syncing the driver copy."
else
  step "Publishing $PACKAGE@$NEXT"
  node scripts/publish-addon.mjs "$SKILL_DIR" 2>&1 | grep -vE '^npm notice [0-9]'
fi

step "Done"
if [ -n "$(git status --porcelain -- addons/skills apps/praxis-mobile/tools/device-driver)" ]; then
  echo "Commit the changes so the repo matches what was published:"
  echo "  git add addons/skills apps/praxis-mobile/tools/device-driver"
  echo "  git commit -m \"chore(marketplace): publish mobile-device-testing $NEXT\" && git push"
fi
