#!/usr/bin/env bash
# Build a locally signed Praxis installer without writing credentials to disk.
set -euo pipefail

TARGET="mac"
CERTIFICATE=""
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Usage: ./scripts/build-signed-installer.sh [options]

Options:
  --target <mac|win>       Platform to sign (default: mac)
  --certificate <path>    Developer ID Application .p12 (mac) or Authenticode .pfx (win)
  --skip-build             Reuse existing compiled application output
  --help, -h               Show this help

Credentials may already be exported using electron-builder's standard names.
Otherwise this script prompts for missing values. Password prompts are hidden.

macOS environment variables:
  CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID,
  APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID

Windows environment variables:
  WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --certificate) CERTIFICATE="${2:-}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

prompt_plain() {
  local variable_name="$1"
  local prompt="$2"
  local value=""
  read -r -p "$prompt" value
  [[ -n "$value" ]] || { echo "A value is required." >&2; exit 1; }
  printf -v "$variable_name" '%s' "$value"
}

prompt_secret() {
  local variable_name="$1"
  local prompt="$2"
  local value=""
  read -r -s -p "$prompt" value
  printf '\n'
  [[ -n "$value" ]] || { echo "A value is required." >&2; exit 1; }
  printf -v "$variable_name" '%s' "$value"
}

resolve_certificate() {
  local path="$1"
  [[ -f "$path" ]] || { echo "Certificate not found: $path" >&2; exit 1; }
  (cd "$(dirname "$path")" && printf '%s/%s\n' "$PWD" "$(basename "$path")")
}

installer_args=(--target "$TARGET")
[[ "$SKIP_BUILD" -eq 1 ]] && installer_args+=(--skip-build)

case "$TARGET" in
  mac)
    [[ "$(uname -s)" == "Darwin" ]] || { echo 'macOS signing and notarization must run on macOS.' >&2; exit 1; }

    if [[ -z "${CSC_LINK:-}" ]]; then
      [[ -n "$CERTIFICATE" ]] || prompt_plain CERTIFICATE 'Developer ID Application .p12 path: '
      CSC_LINK="$(resolve_certificate "$CERTIFICATE")"
    fi
    [[ -n "${CSC_KEY_PASSWORD:-}" ]] || prompt_secret CSC_KEY_PASSWORD '.p12 password: '
    [[ -n "${APPLE_ID:-}" ]] || prompt_plain APPLE_ID 'Apple ID email: '
    [[ -n "${APPLE_TEAM_ID:-}" ]] || prompt_plain APPLE_TEAM_ID 'Apple Developer Team ID: '
    [[ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]] || prompt_secret APPLE_APP_SPECIFIC_PASSWORD 'Apple app-specific password: '

    export CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD
    "$SCRIPT_DIR/build-installer.sh" "${installer_args[@]}"
    ;;
  win|windows|nsis)
    TARGET="win"
    installer_args=(--target win)
    [[ "$SKIP_BUILD" -eq 1 ]] && installer_args+=(--skip-build)

    if [[ -z "${WIN_CSC_LINK:-}" ]]; then
      [[ -n "$CERTIFICATE" ]] || prompt_plain CERTIFICATE 'Authenticode .pfx path: '
      WIN_CSC_LINK="$(resolve_certificate "$CERTIFICATE")"
    fi
    [[ -n "${WIN_CSC_KEY_PASSWORD:-}" ]] || prompt_secret WIN_CSC_KEY_PASSWORD '.pfx password: '

    export WIN_CSC_LINK WIN_CSC_KEY_PASSWORD
    "$SCRIPT_DIR/build-installer.sh" "${installer_args[@]}"
    ;;
  *)
    echo "Unsupported signing target: $TARGET (use mac or win)" >&2
    exit 1
    ;;
esac
