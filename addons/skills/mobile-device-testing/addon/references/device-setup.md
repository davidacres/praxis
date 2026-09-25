# Device setup

What must be true before anything can be driven, and how to get there. Relay
the phone-side steps to the user; you cannot change settings on the phone.

## Mac

- Xcode (full app, not only command-line tools), opened once so it installs its
  components. Check: `xcodebuild -version`.
- The Apple account that owns the development team is signed in under
  Xcode → Settings → Accounts. The command line uses it for automatic signing.
- CocoaPods (`brew install cocoapods`). The driver's project generator uses the
  `xcodeproj` gem bundled with it; `gem install xcodeproj` also works.
- Flutter (`flutter --version`) and the Praxis repository; `flutter pub get`
  in `apps/praxis-flutter` installs the app's packages and Pods.

## Physical iPhone — first time

Ask the user to do these on the phone, in this order:

1. **Connect by USB and trust.** Unlock the phone, connect the cable, tap
   *Trust* and enter the passcode when "Trust This Computer?" appears.
2. **Developer Mode.** Settings → Privacy & Security → Developer Mode → on. The
   phone restarts; after unlocking, confirm *Turn On*. The setting appears only
   after the phone has been connected to Xcode once — if it is missing, open
   Xcode → Window → Devices and Simulators with the phone connected, then look again.
3. **Enable UI Automation.** Settings → Developer → Enable UI Automation → on.
   (The Developer menu appears once Developer Mode is on.) Without it every
   driven step fails while "enabling automation mode".
4. **Keep it unlocked** during a test run, and turn off auto-lock
   (Settings → Display & Brightness → Auto-Lock → Never) for long journeys.

Then check from the Mac:

```sh
bash preflight.sh
```

Expect ✓ for paired, connected, Developer Mode enabled and developer disk image
services. The UI Automation line is always "?" — confirm it with the user.

## First install on a phone

The first time an app signed by a development team runs on a phone, iOS may
refuse to open it ("Untrusted Developer"). The user must go to Settings →
General → VPN & Device Management → the developer certificate → *Trust*. The
same applies to the driver's test runner (`com.acresweb.praxis.driver`) on its
first run.

## Simulator

- List: `xcrun simctl list devices available`. Boot one:
  `xcrun simctl boot "<udid>"` and `open -a Simulator` to see it.
- No Developer Mode, UI Automation, trust or signing is needed.
- The simulator shares the Mac's network, so the desktop's mobile listener is
  reachable at `127.0.0.1` on its port (default 43100).
- There is no camera. Pair with the pasted invitation instead of the QR code.
- A simulator is a different device: it needs its own pairing, confirmed on
  the desktop, like a new phone.

## Praxis desktop (for tests that connect)

- Praxis desktop running, Settings → Mobile access → Local network.
- To pair a new device: Settings → Mobile access → *Create pairing invitation*,
  then scan the QR (phone) or copy the invitation (simulator, or phone without
  camera). The device then shows "Waiting for confirmation" until the user
  confirms it on the desktop and grants projects and capabilities.
- Invitations expire after 10 minutes and are single use.
