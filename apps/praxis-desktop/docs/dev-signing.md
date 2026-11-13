# Stable dev signing (macOS, optional)

`scripts/run-app.sh` launches an unsigned debug build. macOS ties Keychain
"Always Allow" to the app's code-signing identity, and an unsigned build gets a new
identity on every rebuild, so the login password prompt returns after each rebuild
(once per rebuild, since all secrets live in one keychain item).

## One-time setup

```bash
./scripts/setup-dev-signing.sh --dry-run   # shows what it would do
./scripts/setup-dev-signing.sh             # asks, then does it
```

It creates a self-signed code-signing certificate named `Praxis Dev` in your login
keychain and trusts it for code signing only. macOS asks for your login password for
the trust step. It is idempotent. Prefer clicking? Keychain Access > Certificate
Assistant > Create a Certificate: name `Praxis Dev`, Identity Type *Self Signed Root*,
Certificate Type *Code Signing*, then trust it for Code Signing.

## What to expect

- `run-app.sh` signs `target/debug/Praxis.app` with `--identifier com.praxis.app`
  after preparing the bundle. It prints `Signed dev bundle as "Praxis Dev"`.
- The first launch after signing prompts once: choose **Always Allow**. Later rebuilds
  keep the same designated requirement, so they stop prompting.
- If the identity is missing or untrusted the step is skipped silently and nothing
  changes. `PRAXIS_DEV_SIGN=0` skips it explicitly.

## Why the identity is stable

For a self-signed certificate the designated requirement is
`identifier "com.praxis.app" and certificate leaf = H"<cert sha1>"`. It names the bundle
id and the certificate, not the binary hash, so it survives rebuilds as long as the
certificate is the same. Check it with `codesign -d -r- target/debug/Praxis.app` before
and after a rebuild; the line must be identical. If you recreate the certificate the
hash changes and you will be asked once more.

## You may not need the setup script

`scripts/run-app.sh` signs the dev bundle with the first of: `PRAXIS_DEV_SIGN_IDENTITY`, a `Praxis Dev`
certificate (from `setup-dev-signing.sh`), or an `Apple Development` identity already in your keychain
(any Xcode or Apple Developer account makes one). Check with `security find-identity -v -p codesigning`.
Set `PRAXIS_DEV_SIGN=0` to launch unsigned.

The first signed launch asks twice: once to let `codesign` use the certificate's key, and once for the
app to read its keychain item. Choose **Always Allow** both times. The app's signature then stays the same
across rebuilds, so macOS stops asking.

