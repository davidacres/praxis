# Physical iPhone: build, install, verify

Run from the Praxis repository root unless stated. Get `<udid>` and
`<CoreDevice id>` from `bash preflight.sh`.

## Build Release

```sh
npm run build:core && npm run build:mobile-protocol   # shared packages the app bundles
cd apps/praxis-mobile
xcodebuild -workspace ios/Praxis.xcworkspace -scheme Praxis -configuration Release \
  -destination 'id=<udid>' -allowProvisioningUpdates build > /tmp/praxis-ios-build.log 2>&1
grep -E 'error:|\*\* BUILD' /tmp/praxis-ios-build.log
```

Takes 3–6 minutes cold. Run it in the background if your tools allow and report
when it finishes. `** BUILD SUCCEEDED **` is required.

The product is under DerivedData:

```sh
APP=$(ls -d ~/Library/Developer/Xcode/DerivedData/Praxis-*/Build/Products/Release-iphoneos/Praxis.app | head -1)
```

## Verify the bundle before installing

```sh
wc -c < "$APP/main.jsbundle"            # must be non-zero (about 1.8 MB)
file "$APP/main.jsbundle"               # Hermes JavaScript bytecode
strings "$APP/main.jsbundle" | grep -c "<a string you just added>"   # proves it is the new code
/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP/Info.plist"   # com.acresweb.praxis.mobile
```

`grep` directly on the bundle prints nothing useful because it is bytecode —
use `strings` first. A missing `main.jsbundle` or a product under
`Debug-iphoneos` means the build was Debug: rebuild with `-configuration Release`.

## Install and launch

```sh
xcrun devicectl device install app --device <CoreDevice id> "$APP"
xcrun devicectl device process launch --device <CoreDevice id> --terminate-existing com.acresweb.praxis.mobile
```

## Prove it started (`Running "main"`)

React Native logs `Running "main"` to the unified log, not stdout. Capture it
without root by mirroring the log to the attached console:

```sh
perl -e 'alarm 30; exec @ARGV' xcrun devicectl device process launch \
  --device <CoreDevice id> --terminate-existing --console \
  --environment-variables '{"OS_ACTIVITY_DT_MODE":"1"}' \
  com.acresweb.praxis.mobile > /tmp/praxis-launch.log 2>&1
grep -E 'Running "main"|evaluateJavaScript|No script URL|RCTFatal|TypeError|ReferenceError' /tmp/praxis-launch.log
```

Expect `evaluateJavaScript() with JS bundle` and `[javascript] Running "main"`,
and no `No script URL provided` or JS errors. The alarm ends the attached
session — and the app with it ("terminated due to signal 14" is expected) — so
relaunch without `--console` afterwards:

```sh
xcrun devicectl device process launch --device <CoreDevice id> --terminate-existing com.acresweb.praxis.mobile
```

Notes:
- macOS has no `timeout` command; use the `perl -e 'alarm N; exec @ARGV'` wrapper.
- In zsh, `log` is a shell builtin; call `/usr/bin/log`. `log collect --device`
  needs root, which is why the console mirror above is used instead.
- Check the app is running: `xcrun devicectl device info processes --device <CoreDevice id> | grep Praxis`.
