# Physical iPhone: build, install, verify

Run from the Praxis repository root unless stated. The app is the Flutter app
in `apps/praxis-mobile` (bundle id `com.acresweb.praxis.mobile.praxis`,
shown on the phone as "Praxis Flutter").

## One-command deployment (recommended)

```sh
./scripts/deploy-iphone.sh
# or via npm:
npm run mobile:deploy
```

It auto-detects the connected device, builds the Flutter Release app, checks
the compiled Dart code is embedded, installs and launches it.

## Manual build

Get `<udid>` and `<CoreDevice id>` from `bash preflight.sh`.

```sh
cd apps/praxis-mobile
flutter pub get
flutter build ios --release --no-codesign            # compiles Dart and generates the Xcode settings
cd ios
xcodebuild -workspace Runner.xcworkspace -scheme Runner -configuration Release \
  -destination 'id=<udid>' -derivedDataPath build/device-release \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=WY4B2H77A5 build > /tmp/praxis-ios-build.log 2>&1
grep -E 'error:|\*\* BUILD' /tmp/praxis-ios-build.log
APP=apps/praxis-mobile/ios/build/device-release/Build/Products/Release-iphoneos/Runner.app
```

`** BUILD SUCCEEDED **` is required.

## Verify the product before installing

```sh
ls -l "$APP/Frameworks/App.framework/App"                                  # the compiled Dart code
/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP/Info.plist"   # com.acresweb.praxis.mobile.praxis
```

A Flutter Release build needs no dev server, so there is no blank-screen
failure mode like a Debug React Native build.

## Install and launch

```sh
xcrun devicectl device install app --device <CoreDevice id> "$APP"
xcrun devicectl device process launch --device <CoreDevice id> --terminate-existing com.acresweb.praxis.mobile.praxis
```

A personal (free) team allows only **three** sideloaded apps on a phone. An
install refused with "maximum number of installed apps using a free developer
profile" needs one removed first — ask the user which
(`xcrun devicectl device uninstall app --device <CoreDevice id> <bundle id>`).

## Capture launch logs

Mirror the unified log to the console without root:

```sh
perl -e 'alarm 30; exec @ARGV' xcrun devicectl device process launch \
  --device <CoreDevice id> --terminate-existing --console \
  --environment-variables '{"OS_ACTIVITY_DT_MODE":"1"}' \
  com.acresweb.praxis.mobile.praxis > /tmp/praxis-launch.log 2>&1
grep -iE 'flutter|exception|error' /tmp/praxis-launch.log
```

The alarm ends the attached session — and the app with it — so relaunch
without `--console` afterwards.

Notes:
- macOS has no `timeout` command; use the `perl -e 'alarm N; exec @ARGV'` wrapper.
- In zsh, `log` is a shell builtin; call `/usr/bin/log`.
- Check the app is running: `xcrun devicectl device info processes --device <CoreDevice id> | grep Runner`.
