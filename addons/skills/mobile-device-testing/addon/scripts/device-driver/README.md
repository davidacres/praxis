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
- The marketplace skill ships a copy of these scripts — see below.

## The marketplace skill

This driver also ships inside the **Mobile device testing** skill in the Praxis
marketplace (`@davidacres/praxis-addon-mobile-device-testing`, source in
`addons/skills/mobile-device-testing/`). The skill tells an agent how to run
these tests on a simulator or an iPhone: it explains what it can do, asks
before starting (and about Developer Mode, UI Automation and pairing), then
builds, installs, drives the app and reports evidence. Its `SKILL.md` and
`references/` hold the procedure; `scripts/device-driver/` is a copy of this
folder so it works outside the repository.

Install it in Praxis from Settings → Marketplace and grant it trust. Praxis
places it in `~/Library/Application Support/Praxis/skills/mobile-device-testing/`.

### Publishing a new version

After changing anything in this folder or in the skill, run:

```sh
./publish-skill.sh --dry-run   # check first: token, sync, validation, next version
./publish-skill.sh             # publish
```

It does every step:

1. **Picks the token** in this order and checks it has `write:packages`
   (it never prints it):
   1. `PRAXIS_MARKETPLACE_TOKEN`, if set;
   2. the `//npm.pkg.github.com/:_authToken=` line in `~/.npmrc`;
   3. `GITHUB_TOKEN` — last, because it is usually a CLI/CI token without
      package scopes (publishing with it fails with
      `403 … The token provided does not match expected scopes`).
2. **Builds core** and runs `node scripts/build-skill-addons.mjs`, which copies
   this folder into the skill (minus `.run/`, the generated project,
   `.gitignore` and this publish script), validates the manifest, and checks
   Praxis's skill discovery accepts `SKILL.md`.
3. **Bumps the version** when the local version is not newer than the
   published one: patch by default, `--bump minor|major`, or `--version x.y.z`.
   It updates `package.json`, `praxis.contentVersion` and `SKILL.md` together.
   A dry run only reports the version it would use.
4. **Publishes** with `node scripts/publish-addon.mjs` to
   `https://npm.pkg.github.com`.
5. **Reminds you to commit** the synced copy and version bump, so the repo
   matches what was published.

To check only that the skill's copy is current (for example in CI):
`node scripts/build-skill-addons.mjs --check` fails when it is out of date.
