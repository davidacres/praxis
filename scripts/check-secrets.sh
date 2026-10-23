#!/usr/bin/env bash
# Scan for committed secrets with gitleaks.
#
#   scripts/check-secrets.sh                # staged changes only (pre-commit)
#   scripts/check-secrets.sh --tree         # the whole working tree (CI)
#   scripts/check-secrets.sh --range A..B   # a commit range (CI on pull requests)
#   scripts/check-secrets.sh --history      # every reachable commit (CI)
#
# --tree and --range only ever see the current state, so a credential that was
# committed and later deleted stays invisible to both. --history closes that gap:
# it is what would have caught the GitHub PAT in e2e/marketplace.spec.ts, which
# lived across six commits on main and was already gone from the working tree.
#
# Findings confirmed rotated at their issuer are suppressed via .gitleaksignore,
# which holds fingerprints only — never a secret value. Those fingerprints embed
# a commit SHA, and pushed commits are immutable, so they cannot go stale the way
# the working-tree fingerprints task-107-3 rejected would.
#
#   scripts/check-secrets.sh --history-baseline   # print fingerprints to append
#
# Config and fixture allowlist: .gitleaks.toml. Install: brew install gitleaks
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "check-secrets: gitleaks is not installed (brew install gitleaks) — skipping." >&2
  exit 0
fi

common=(--config .gitleaks.toml --redact --no-banner)

# Print the fingerprints of every finding in history, so each can be confirmed
# rotated at its issuer before being appended to .gitleaksignore.
#
# This scans a throwaway --no-checkout clone rather than the working tree. gitleaks
# resolves .gitleaksignore against the *scan target*, and --gitleaks-ignore-path
# cannot override a file the target already has, so the only way to see the
# unsuppressed findings is to scan a tree that does not contain the file. Cloning
# shares the object store (~3s) and never touches the working tree; temporarily
# moving .gitleaksignore aside would strand it if the process were killed.
#
# Scope note: a clone carries only commits reachable from a ref, so a dangling
# local-only commit is out of scope here — the same scope CI sees from a fresh
# checkout. --history scans the real repository, so it still flags those locally.

# The JSON report holds plaintext secret values (--redact covers logs and stdout,
# not the report file), which is why it lives inside the temp clone and why the
# sanitizer below prints fingerprints only. Both are removed by this trap.
#
# Set in global scope on purpose: a trap body is evaluated when the signal
# fires, by which point the function's `local` variables are out of scope. With
# `set -u` that turns a cleanup trap into an "unbound variable" error, so the
# trap runs and deletes nothing — the failure mode this design has to avoid.
BASELINE_TMP=""
baseline_cleanup() {
  if [ -n "$BASELINE_TMP" ] && [ -d "$BASELINE_TMP" ]; then
    rm -rf "$BASELINE_TMP"
  fi
  BASELINE_TMP=""
}
trap baseline_cleanup EXIT INT TERM

emit_history_baseline() {
  local repo config clone report
  repo="$(pwd)"
  config="$repo/.gitleaks.toml"
  BASELINE_TMP="$(mktemp -d)"
  clone="$BASELINE_TMP/repo"

  git clone -q --no-checkout --local "$repo" "$clone"
  report="$clone/.gitleaks-report.json"
  ( cd "$clone" && gitleaks git . --config "$config" --redact --no-banner \
      --report-format json --report-path "$report" >/dev/null 2>&1 ) || true

  if [ ! -s "$report" ]; then
    echo "no findings in history — nothing to baseline." >&2
    return 0
  fi
  python3 - "$report" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
seen = set()
for r in sorted(rows, key=lambda r: r["Fingerprint"]):
    fp = r["Fingerprint"]
    if fp in seen:
        continue
    seen.add(fp)
    # Deliberately prints no Secret/Match: this output is meant to be committed.
    print(f"# {r['File']}  ({r['RuleID']}, commit {r['Commit'][:8]})")
    print(fp)
PY
}

case "${1:-}" in
  --tree)  exec gitleaks dir . "${common[@]}" ;;
  --range) exec gitleaks git . "${common[@]}" --log-opts="${2:?range required}" ;;
  --history)
    exec gitleaks git . "${common[@]}" ;;
  --history-baseline)
    emit_history_baseline ;;
  "")      exec gitleaks git . "${common[@]}" --staged ;;
  *)       echo "usage: $0 [--tree | --range A..B | --history | --history-baseline]" >&2; exit 2 ;;
esac
