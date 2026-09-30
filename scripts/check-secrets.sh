#!/usr/bin/env bash
# Scan for committed secrets with gitleaks.
#
#   scripts/check-secrets.sh            # staged changes only (pre-commit)
#   scripts/check-secrets.sh --tree     # the whole working tree (CI)
#   scripts/check-secrets.sh --range A..B   # a commit range (CI on pull requests)
#
# Config and fixture allowlist: .gitleaks.toml. Install: brew install gitleaks
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "check-secrets: gitleaks is not installed (brew install gitleaks) — skipping." >&2
  exit 0
fi

common=(--config .gitleaks.toml --redact --no-banner)

case "${1:-}" in
  --tree)  exec gitleaks dir . "${common[@]}" ;;
  --range) exec gitleaks git . "${common[@]}" --log-opts="${2:?range required}" ;;
  "")      exec gitleaks git . "${common[@]}" --staged ;;
  *)       echo "usage: $0 [--tree | --range A..B]" >&2; exit 2 ;;
esac
