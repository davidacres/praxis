# Deploying Praxis to a real iPhone

This is the supported local procedure for installing the Praxis mobile app on
a physical iPhone. It is intentionally different from the simulator/Metro
workflow: the phone must receive a self-contained Release build.

## Prerequisites

- Xcode is installed and the iPhone is connected by USB, unlocked, and trusted.
- The phone is enabled for development in Xcode.
- The Apple account is available in Xcode Settings → Accounts.
- The generated iOS project exists at `apps/praxis-mobile/ios`.

Expo Go is not sufficient. Praxis uses native TCP/UDP, camera, and secure
storage modules.

## Automated script deployment (Recommended)

Deploy to the connected physical iPhone with a single command (no parameters required):

```sh
./scripts/deploy-iphone.sh
```

Or via npm from anywhere in the monorepo:

```sh
npm run mobile:deploy
```

The script runs with zero parameters and automatically:
1. Detects the connected physical iPhone and resolves both its Xcode UDID and CoreDevice ID.
2. Compiles the core dependencies (`@praxis/core` and `@praxis/mobile-protocol`).
3. Compiles the iOS project in self-contained **Release** configuration.
4. Verifies the embedded Hermes JavaScript bundle (`main.jsbundle`, >100 KB) is present.
5. Installs the app onto the phone and launches it.

Optional flags:
- `--skip-build`: Skip recompilation and install the existing Release build immediately.
- `--clean`: Clean the build cache before compiling.
- `--no-launch`: Install without launching.
- `--device <id>`: Target a specific device if multiple are connected.

## Manual Xcode deployment

1. Open `apps/praxis-mobile/ios/Praxis.xcworkspace` in Xcode. Open the
   workspace, not `Praxis.xcodeproj` directly.
2. Select the `Praxis` target → Signing & Capabilities.
3. Enable Automatically manage signing and select the development team. The
   bundle identifier must be `com.acresweb.praxis.mobile`.
4. Select the connected iPhone as the Run destination.
5. Open Product → Scheme → Edit Scheme… → Run → Info and verify **Build
   Configuration** is set to **Release** (this scheme is checked in as Release).
6. Run the `Praxis` scheme (<kbd>⌘</kbd> + <kbd>R</kbd>). Approve the developer certificate on the phone if
   iOS asks for it, then launch Praxis from Xcode again.

The Release setting is essential. Debug builds set `SKIP_BUNDLING=1` and expect
Metro to be reachable over the network. On a real phone that commonly produces
a blank screen. A successful deployment's Xcode console includes `Running
"main"` and `evaluateJavaScript() with JS bundle`; it must not include `No
script URL provided`.

## Verification

Confirm that the installed product is the intended Praxis app, not another
Xcode target:

```sh
xcrun devicectl list devices
xcrun devicectl device info apps \
  --device <core-device-id>
```

The app entry must be `com.acresweb.praxis.mobile`. For a local Xcode build,
the Release product should contain the embedded bundle:

```sh
find ~/Library/Developer/Xcode/DerivedData \
  -path '*/Build/Products/Release-iphoneos/Praxis.app' -type d -print
wc -c <path-to-Praxis.app>/main.jsbundle
```

The bundle should be non-empty (~2 MB). If the product is under
`Debug-iphoneos`, or `main.jsbundle` is missing, stop and correct the scheme
configuration before testing the app.

## Troubleshooting

- **Blank screen:** Blank screens on physical iOS devices have two distinct causes:
  1. *Debug build missing bundle:* The build was compiled in Debug mode where `SKIP_BUNDLING=1` is set, expecting Metro. Run `./scripts/deploy-iphone.sh` or ensure the Xcode Run scheme is set to **Release**.
  2. *Unhandled JS runtime error during initialization:* A module threw a fatal error before the React tree mounted (e.g. an unlinked native module such as `ExpoLocalAuthentication` when pods haven't been recompiled). To diagnose, capture the launch logs:
     ```sh
     xcrun devicectl device process launch --device <core-device-id> --terminate-existing --console \
       --environment-variables '{"OS_ACTIVITY_DT_MODE":"1"}' com.acresweb.praxis.mobile
     ```
     Look for `[javascript] [runtime not ready]: Error: Cannot find native module ...`. Any native module with optional or conditional linkage must be loaded safely with a fallback to avoid crashing boot.
- **`No script URL provided`:** the app is still a Debug/Metro build or the
  embedded bundle step did not run. Do not test pairing until the Release
  bundle is present.
- **Signing/profile errors:** resolve the account and team in Xcode's GUI,
  enable automatic signing, and let Xcode create the managed profile. The
  command-line build may not see an account that the GUI can use.
- **The phone is not listed:** unlock it, accept the Trust This Computer prompt,
  reconnect the cable, and check Xcode's Devices and Simulators window.

To drive the installed app from the command line (taps, typing,
accessibility tree and screenshots), use the
[device driver](../tools/device-driver/README.md).

After the app opens, verify the real journey separately: desktop Mobile access
listener enabled, pair and confirm the device, grant the required scopes, then
connect to a live session and confirm streamed responses.
