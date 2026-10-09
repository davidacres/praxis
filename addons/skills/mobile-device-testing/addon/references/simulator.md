# Simulator: build, install, drive

## Pick and boot a simulator

```sh
xcrun simctl list devices available | grep iPhone
xcrun simctl boot "<simulator udid>"      # skip if already Booted
open -a Simulator                          # optional: watch it
```

`bash setup.sh --simulator ["<name>"]` also boots one for you.

## Build and install

```sh
cd apps/praxis-mobile
flutter build ios --simulator --debug
xcrun simctl install booted build/ios/iphonesimulator/Runner.app
xcrun simctl launch booted com.acresweb.praxis.mobile.praxis
```

`flutter run -d <simulator udid>` also builds, installs and gives hot reload.

For realistic data without a real desktop, run the stage desktop
(`node apps/praxis-mobile/tool/stage_host.cjs`): the desktop's own LAN
listener and host services over sample sessions, runs and questions. It prints
a pairing invitation for `127.0.0.1`, which the simulator can reach.

Useful simulator commands:

```sh
xcrun simctl io booted screenshot /tmp/sim.png            # screenshot without the driver
xcrun simctl spawn booted log stream --predicate 'process == "Runner"' --style compact   # live logs (no root needed)
printf '%s' "<text>" | xcrun simctl pbcopy booted          # put text on the simulator clipboard
xcrun simctl uninstall booted com.acresweb.praxis.mobile.praxis  # reset the app (drops pairing and keys)
xcrun simctl terminate booted com.acresweb.praxis.mobile.praxis
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
