# Device driver

Drives the installed Praxis app on a physical iPhone or an iOS simulator from
the command line, for
device testing and evidence (TASK-241). It is an XCUITest bundle that attaches
to the app by bundle id, so it tests the real Release build — nothing is added
to the Praxis app or its Xcode project.

Each run performs a list of actions, then records the accessibility tree and a
screenshot. That is enough to drive a full journey one step at a time and to
check what the phone actually shows.

## Setup

Requirements: Xcode, CocoaPods (its bundled `xcodeproj` gem generates the
project), an iPhone connected by USB, unlocked and trusted, with
**Settings → Developer → Enable UI Automation** on, and the Praxis Release build
installed (see [iOS phone deployment](../../docs/ios-phone-deployment.md)).

```sh
cd apps/praxis-mobile/tools/device-driver
./preflight.sh                  # read-only: paired, connected, Developer Mode, DDI services
./setup.sh                      # first connected iPhone
./setup.sh --simulator [name]   # booted simulator, else the first matching one (booted for you)
```

`setup.sh` generates `PraxisDriver.xcodeproj`, signs it with the Praxis app's
development team (needed only for a physical iPhone), picks the device and
builds the test bundle. Re-run it after editing `DriverUITests/DriverTests.swift`
or changing device. For a simulator, install a Release build first
(`xcrun simctl install booted <…/Release-iphonesimulator/Praxis.app>`).

Outside this repository (for example the copy shipped in the
`mobile-device-testing` marketplace skill) set `PRAXIS_DRIVER_TEAM` or
`PRAXIS_IOS_PROJECT` for a physical iPhone, and run the scripts with `bash`.

| Variable | Default |
| --- | --- |
| `PRAXIS_DEVICE_ID` | The first connected iPhone (recorded by `setup.sh`) |
| `PRAXIS_DRIVER_TEAM` | `DEVELOPMENT_TEAM` from `ios/Praxis.xcodeproj` (physical iPhone only) |
| `PRAXIS_IOS_PROJECT` | Path to a `Praxis.xcodeproj` to read the team from |
| `PRAXIS_DRIVER_RUN_DIR` | `.run/` next to the scripts |
| `PRAXIS_DRIVER_BUNDLE_PREFIX` | `com.acresweb.praxis` (driver apps are `<prefix>.driver…`) |
| `PRAXIS_APP_BUNDLE_ID` | `com.acresweb.praxis.mobile` — the app being driven |

## Running steps

```sh
./step.sh "<action>;;<action>;;…" [settle-seconds]
./labels.sh            # element types and labels from the last step
```

Results land in `.run/` (gitignored): `tree.txt` (full accessibility tree),
`screen.png` (screenshot) and `run.log`.

| Action | Effect |
| --- | --- |
| `launch` | Relaunch the app (first action only); otherwise the running app is brought forward |
| `tap:<label>` | Tap the element whose accessibility label or identifier is exactly `<label>` |
| `tapprefix:<text>` | Tap the first element whose label starts with `<text>` |
| `type:<text>` | Type into the focused field (tap it first) |
| `wait:<seconds>` | Pause, e.g. for a streamed reply |
| `home` / `activate` | Background the app / bring it back |
| `swipeup` / `swipedown` | Scroll |
| `tapxy:<x>,<y>` | Tap a point, in points from the top-left |

Labels come from the app's `accessibilityLabel`s; `./labels.sh` shows what is on
screen now. A composite control's label joins its parts, which is why
`tapprefix` exists (a multiline field's label includes its placeholder, and a
picker row's label includes its caption).

Example: start a chat on a chosen provider and model.

```sh
./step.sh "launch;;wait:6;;tap:Open navigation;;tap:New chat;;tap:Codex CLI (local)"
./step.sh "tapprefix:Claude Code (local), Local agent;;tapprefix:Default;;wait:6;;tapprefix:Haiku, haiku"
./step.sh "tapprefix:Session message;;type:Reply with exactly: ok;;tap:Send message;;wait:30"
./labels.sh
```

## Notes

- A step that cannot find its target prints `DRIVER NOT FOUND <label>` and
  carries on; the tree shows what was there instead.
- Tapping text that sits under the keyboard lands on the keyboard. Check
  element frames in `tree.txt` against the keyboard when a tap misses.
- Each step is a separate `xcodebuild test-without-building` run (roughly
  10–20 s of overhead), so combine actions where you can.
- Messages sent through the driver start real agent turns on the desktop and
  spend real tokens; prefer cheap models and short prompts.
- `preflight.sh` cannot see Settings → Developer → Enable UI Automation; if every
  step fails while "enabling automation mode", that setting is off.
- The marketplace skill `addons/skills/mobile-device-testing` ships a copy of
  these scripts. After changing them run `node scripts/build-skill-addons.mjs`.
