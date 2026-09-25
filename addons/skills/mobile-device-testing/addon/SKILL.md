---
name: mobile-device-testing
title: Mobile Device Testing
description: Run automated UI tests of the Praxis mobile app on an iOS simulator or a physical iPhone — device setup checks, Release build and install, XCUITest-driven taps and typing, and screenshot/accessibility-tree evidence. Use when asked to test, verify, reproduce or demonstrate anything in the Praxis mobile app on a simulator or phone.
version: 1.0.2
triggers: test on phone, test on iphone, test on device, test on simulator, ios simulator, physical device, real phone, device testing, ui automation, xcuitest, mobile e2e, drive the app, control the phone
---

# Mobile device testing

You can build, install and drive the Praxis mobile app (the Flutter app, `com.acresweb.praxis.mobile.praxis`)
on an iOS simulator or a physical iPhone, and record what it shows. You do this
with Xcode's command-line tools and a small XCUITest driver bundled with this
skill. Everything runs on the user's Mac; nothing is installed on the phone
except the Praxis app and the driver's test runner.

## How to work with the user

Follow this order. Do not skip the confirmation step.

1. **Say what you can do and what it needs.** In a few lines: you know how to run
   this on a simulator and on a real iPhone; list what that involves for the
   target they asked about (building a Release app, installing it, running an
   XCUITest driver that taps and types, capturing screenshots), how long it
   roughly takes (first build 3–6 minutes; each driven step 10–20 seconds), and
   anything with side effects (see *Side effects* below).
2. **Ask before doing it.** Ask whether they want you to go ahead, and on which
   target if they did not say. For a physical iPhone, ask in the same message:
   - Is the iPhone connected by USB, unlocked, and has this Mac been trusted?
   - Is **Developer Mode** on (Settings → Privacy & Security → Developer Mode)?
   - Is **Enable UI Automation** on (Settings → Developer → Enable UI Automation)?
     This one cannot be checked from the Mac.
   - For tests that talk to the desktop: is Praxis desktop running with
     Settings → Mobile access set to Local network, and is this phone already
     paired?
   Run `preflight.sh` (below) first when you can — it answers most of these
   without asking, so only ask about what it cannot see.
3. **Do the work** once they say yes, following the procedure below. Report
   progress briefly between long steps (builds, installs, driven journeys).
4. **Stop and ask** when something needs a person: a setting on the phone, a
   pairing confirmation on the desktop, an Apple account/signing prompt, or an
   action that spends money or changes their data beyond what they agreed.
5. **Report evidence, not impressions**: which build, which device, what each
   step showed (quote labels from the tree, look at the screenshot), what
   passed, what failed, and anything you could not test.

## Where the driver is

Use the first that exists:

1. In the Praxis repository: `tools/device-driver/`.
2. This skill's own copy: `scripts/device-driver/` inside this skill's folder.
   An installed skill lives at
   `~/Library/Application Support/Praxis/skills/mobile-device-testing/`.
   Copy the folder somewhere writable first, e.g.
   `cp -R ".../skills/mobile-device-testing/scripts/device-driver" "$TMPDIR/praxis-device-driver"`,
   and run the scripts with `bash` (installed files may lose their executable bit).

Outside the repository `setup.sh` cannot read the signing team from the Praxis
Xcode project; set `PRAXIS_DRIVER_TEAM=<team id>` or
`PRAXIS_IOS_PROJECT=<path to Praxis.xcodeproj>` for a physical iPhone. A
simulator needs neither.

## Procedure

Full commands and variations are in the references; this is the order.

### 1. Preflight (read-only)

```sh
bash preflight.sh              # physical iPhones: paired, connected, Developer Mode, DDI services
bash preflight.sh --simulator  # booted simulator and whether Praxis is installed
```

Any ✗ is something to fix or ask about before building. Note both ids it
prints: **udid** is what `xcodebuild` uses; **CoreDevice id** is what
`xcrun devicectl` uses. They are different.

### 2. Build and install the app

Details: `references/physical-iphone.md`, `references/simulator.md`.

- Physical iPhone: `./scripts/deploy-iphone.sh` builds the Flutter app in
  Release, installs and launches it.
- Simulator: `flutter build ios --simulator --debug` in `apps/praxis-flutter`,
  then `xcrun simctl install booted build/ios/iphonesimulator/Runner.app`.
- Verify the product before testing: `Runner.app/Frameworks/App.framework/App`
  (the compiled Dart code) exists and the bundle id is
  `com.acresweb.praxis.mobile.praxis`.

### 3. Set up the driver

```sh
bash setup.sh                       # first connected iPhone
bash setup.sh --simulator           # booted simulator (or boots one)
bash setup.sh --simulator "iPhone 15 Pro"
```

### 4. Drive the app, one step at a time

```sh
bash step.sh "launch;;wait:6;;tap:Open navigation;;tap:New chat"
bash labels.sh        # what is on screen now — pick the next target from here
```

After every step, read `labels.sh` output and, when layout matters, look at
`.run/screen.png`. Actions, label matching and pitfalls:
`references/driving-and-evidence.md`. Journeys for the Praxis app (connect,
new chat with a chosen provider/model, existing-session changes, reconnect):
`references/praxis-journeys.md`.

### 5. Report

Summarise per journey: device and build, steps, what the phone showed, pass or
fail, and what remains untested. Mention anything you changed on the desktop
(restarts, sessions created).

## Side effects — tell the user before causing them

- Messages sent in the app start **real agent turns on the desktop and spend
  tokens**. Use short prompts and cheap models (e.g. Haiku) unless told otherwise.
- A provider change on an existing session is a **handover**: the desktop sends
  a summary to the new provider and starts a turn.
- Revoking, re-pairing, resetting the host key or turning Mobile access off
  breaks the phone's pairing until someone re-pairs it — do these only when
  asked, and warn first.
- Restarting the desktop app interrupts anything running there; check first and
  say so.
- `setup.sh` signs a small test-runner app into the user's development team the
  first time (Xcode may create a provisioning profile).

## When something fails

`references/troubleshooting.md` covers the known failures: UI Automation or
Developer Mode off, signing/provisioning, blank app, taps landing on the
keyboard, `DRIVER NOT FOUND`, device not listed, logs that need root, macOS
`timeout` missing, and more. Diagnose from `.run/run.log` and the tree before
retrying, and never retry the same failing command more than twice without
telling the user what you see.

## Device setup the user may need help with

`references/device-setup.md` walks through first-time iPhone setup (trust,
Developer Mode, UI Automation, Xcode account and team, first-install
certificate trust) and simulator setup, in words suitable to relay to the user.
