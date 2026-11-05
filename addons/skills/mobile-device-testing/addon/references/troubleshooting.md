# Troubleshooting

Read `.run/run.log` (driver) or the build log first; the fix depends on the
exact message.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Step fails with "enabling automation mode", "Timed out while enabling automation mode" or "UI automation is not enabled" | Enable UI Automation is off | Ask the user: Settings → Developer → Enable UI Automation |
| Developer menu missing on the phone | Developer Mode off | Settings → Privacy & Security → Developer Mode (phone restarts); see device-setup.md |
| `preflight.sh`: tunnel unavailable / not connected | Phone locked, cable out, or not trusted | Unlock, reconnect, tap Trust; wait 10 s and re-run preflight |
| Device not in `xcodebuild -showdestinations` or preflight | Not paired with this Mac | Connect by USB, trust, open Xcode → Devices and Simulators once |
| `No profiles for 'com.acresweb.praxis.driver…'`, signing errors | No team or account in Xcode | Set `PRAXIS_DRIVER_TEAM`; sign in under Xcode → Settings → Accounts; keep `-allowProvisioningUpdates` |
| App or test runner won't open: "Untrusted Developer" | First install from this team | Settings → General → VPN & Device Management → Trust |
| A Debug build won't open on the phone | Flutter Debug builds need a connected `flutter run` | Deploy Release with `./scripts/deploy-iphone.sh` |
| Install refused: "maximum number of installed apps using a free developer profile" | A free team allows three sideloaded apps | Ask the user which app to remove; `xcrun devicectl device uninstall app` |
| A screen shows "Something went wrong showing this screen" | A widget failed on data it did not expect | Share details from the card; it is also listed under App settings → Diagnostics |
| `DRIVER NOT FOUND <label>` | Label differs or the screen changed | `bash labels.sh`; use `tapprefix:`; add `wait:` before the tap |
| `Failed to synthesize event: Neither element nor any descendant has keyboard focus` | `type:` without a focused field | Tap the field (`tapprefix:<field label>`) first |
| Typed words appear that you did not send | A tap hit the keyboard's predictions bar | The target is under the keyboard — check frames; report as an app layout bug |
| `step.sh` says run setup first / wrong device | `.run/device-id` missing or stale | Re-run `setup.sh` (or `--simulator`) |
| `xcodeproj` gem missing | CocoaPods not installed | `brew install cocoapods` or `gem install xcodeproj` |
| `timeout: command not found` | macOS has no `timeout` | `perl -e 'alarm N; exec @ARGV' <command>` |
| `log: too many arguments` | zsh builtin `log` | Use `/usr/bin/log` |
| `Must be root to collect logs from attached device` | `log collect --device` needs sudo | Use the `OS_ACTIVITY_DT_MODE` console mirror (physical-iphone.md), or ask the user to run the sudo command themselves |
| App on the phone shows "Desktop unreachable" | Desktop not running, Mobile access off, different network, or port in use | Check the desktop; `lsof -nP -iTCP:43100 -sTCP:LISTEN` on the Mac |
| Desktop e2e test fails with `EADDRINUSE :::43100` | A running Praxis desktop holds the port | Not a regression; stop that instance or skip the spec |
| devicectl rejects an id | Mixed up ids | `devicectl` takes the CoreDevice id; `xcodebuild` takes the udid (both in preflight output) |
