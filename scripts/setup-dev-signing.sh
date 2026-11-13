#!/usr/bin/env bash
#
# OPTIONAL, macOS only: create a local self-signed code-signing identity ("Praxis Dev")
# so debug builds launched by scripts/run-app.sh keep the same code-signing identity
# across rebuilds. Keychain "Always Allow" is bound to that identity, so with a stable
# one macOS stops asking for the login password after every rebuild.
#
# Nothing happens until you run this script. It will:
#   1. generate a 10-year self-signed certificate + key (openssl, in a temp dir)
#   2. import it into your LOGIN keychain (default) with codesign allowed to use the key
#   3. delete the temp dir
#   4. mark that one certificate as trusted for code signing only (your user trust
#      settings; macOS asks for your login password). codesign ignores an untrusted
#      self-signed identity ("no identity found"), so this step is required.
# It adds one certificate and one key and never edits existing keychain items.
# Re-running is a no-op when the identity already exists.
#
# Usage:
#   ./scripts/setup-dev-signing.sh            # prompts before changing anything
#   ./scripts/setup-dev-signing.sh --yes      # no prompt
#   ./scripts/setup-dev-signing.sh --dry-run  # print what would happen, change nothing
#
# Environment:
#   PRAXIS_DEV_SIGN_IDENTITY  certificate common name (default: Praxis Dev)
#   PRAXIS_DEV_SIGN_KEYCHAIN  keychain to import into (default: login keychain);
#                             used to test against a throwaway keychain

set -euo pipefail

IDENTITY="${PRAXIS_DEV_SIGN_IDENTITY:-Praxis Dev}"
KEYCHAIN="${PRAXIS_DEV_SIGN_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
ASSUME_YES=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Code signing identities are only needed on macOS; nothing to do." >&2
  exit 0
fi

if security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "Identity \"$IDENTITY\" already exists in $KEYCHAIN. Nothing to do."
  exit 0
fi

echo "This will create a self-signed code-signing certificate \"$IDENTITY\""
echo "and import it (with its private key) into: $KEYCHAIN"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] no changes made."
  exit 0
fi
if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "Continue? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/openssl.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$WORK/openssl.cnf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null

# macOS `security import` needs a PKCS#12 bundle for a key+cert pair. -legacy keeps the
# older MAC/cipher that Apple's importer understands when OpenSSL 3 is installed.
P12_PASS="praxis-dev-$$"
if ! openssl pkcs12 -export -legacy -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
     -name "$IDENTITY" -passout "pass:$P12_PASS" -out "$WORK/id.p12" 2>/dev/null; then
  openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -name "$IDENTITY" -passout "pass:$P12_PASS" -out "$WORK/id.p12"
fi

security import "$WORK/id.p12" -k "$KEYCHAIN" -P "$P12_PASS" -T /usr/bin/codesign >/dev/null

security find-certificate -c "$IDENTITY" -p "$KEYCHAIN" > "$WORK/cert-trust.pem"
echo "Trusting \"$IDENTITY\" for code signing only (macOS will ask for your password)..."
security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$WORK/cert-trust.pem"

echo
echo "Created \"$IDENTITY\" in $KEYCHAIN."
echo "Next: run ./scripts/run-app.sh. It signs the dev app bundle automatically."
echo "macOS may ask once for your login password when codesign first uses the key (choose"
echo "Always Allow), and once for Praxis's keychain item (choose Always Allow)."
echo "If you prefer Keychain Access: Certificate Assistant > Create a Certificate >"
echo "Name \"$IDENTITY\", Identity Type Self Signed Root, Certificate Type Code Signing."
