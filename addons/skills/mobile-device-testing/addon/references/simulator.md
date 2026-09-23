# Simulator: build, install, drive

## Pick and boot a simulator

```sh
xcrun simctl list devices available | grep iPhone
xcrun simctl boot "<simulator udid>"      # skip if already Booted
open -a Simulator                          # optional: watch it
```

`bash setup.sh --simulator ["<name>"]` also boots one for you.

## Build and install

A Release build embeds the JavaScript, so Metro is not needed:

```sh
npm run build:core && npm run build:mobile-protocol
cd apps/praxis-mobile
xcodebuild -workspace ios/Praxis.xcworkspace -scheme Praxis -configuration Release \
  -destination 'id=<simulator udid>' build > /tmp/praxis-sim-build.log 2>&1
grep -E 'error:|\*\* BUILD' /tmp/praxis-sim-build.log
APP=$(ls -d ~/Library/Developer/Xcode/DerivedData/Praxis-*/Build/Products/Release-iphonesimulator/Praxis.app | head -1)
xcrun simctl install booted "$APP"
xcrun simctl launch booted com.acresweb.praxis.mobile
```

For quick UI iteration you can instead run Metro (`npx expo start` in
`apps/praxis-mobile`) with a Debug build (`npx expo run:ios`); evidence for a
release should come from a Release build.

Useful simulator commands:

```sh
xcrun simctl io booted screenshot /tmp/sim.png            # screenshot without the driver
xcrun simctl spawn booted log stream --predicate 'process == "Praxis"' --style compact   # live logs (no root needed)
printf '%s' "<text>" | xcrun simctl pbcopy booted          # put text on the simulator clipboard
xcrun simctl uninstall booted com.acresweb.praxis.mobile  # reset the app (drops pairing and keys)
xcrun simctl terminate booted com.acresweb.praxis.mobile
```

## Drive it

```sh
bash setup.sh --simulator
bash step.sh "launch;;wait:6"
bash labels.sh
```

Everything in `driving-and-evidence.md` applies. Differences from a phone:

- No camera: to pair, the user creates an invitation on the desktop and copies
  it; type it into the invitation field
  (`tapprefix:Pairing invitation;;type:<invitation text>`) or paste it via the
  clipboard, then set the address to `127.0.0.1` if the invitation lists a LAN
  address the simulator cannot reach.
- The simulator's saved pairing survives reinstalls; uninstall the app to start
  truly fresh.
- A simulator has no Developer Mode / UI Automation settings to check.
