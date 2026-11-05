#!/bin/bash
# Reports whether a phone or simulator is ready to be driven, without changing anything.
#   preflight.sh              connected iPhones
#   preflight.sh --simulator  simulators
source "$(dirname "$0")/lib.sh"
ok() { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s\n' "$1"; }

command -v xcodebuild > /dev/null && ok "Xcode: $(xcodebuild -version | head -1)" || bad "Xcode command-line tools are missing"

if [ "${1:-}" = "--simulator" ]; then
  booted=$(xcrun simctl list devices booted | grep -E 'iPhone' | sed -E 's/^ +//')
  [ -n "$booted" ] && ok "Booted simulator: $booted" || bad "No simulator is booted (setup.sh --simulator boots one)"
  if [ -n "$booted" ]; then
    xcrun simctl get_app_container booted "$PRAXIS_APP_BUNDLE_ID" > /dev/null 2>&1 \
      && ok "$PRAXIS_APP_BUNDLE_ID is installed on the booted simulator" \
      || bad "$PRAXIS_APP_BUNDLE_ID is not installed on the booted simulator"
  fi
  exit 0
fi

json="$RUN_DIR/devices.json"
xcrun devicectl list devices --json-output "$json" > /dev/null 2>&1 || { bad "devicectl could not list devices"; exit 1; }
/usr/bin/python3 - "$json" <<'PY'
import json, sys
devices = [d for d in json.load(open(sys.argv[1])).get('result', {}).get('devices', [])
           if d.get('hardwareProperties', {}).get('platform') == 'iOS' and d.get('hardwareProperties', {}).get('reality') == 'physical']
if not devices:
    print('  ✗ No iPhone known to this Mac. Connect it by USB, unlock it and tap Trust.')
for d in devices:
    hw, conn, props = d.get('hardwareProperties', {}), d.get('connectionProperties', {}), d.get('deviceProperties', {})
    print(f"  • {props.get('name')} ({hw.get('marketingName')}, iOS {props.get('osVersionNumber')})")
    print(f"      udid (xcodebuild): {hw.get('udid')}   CoreDevice id (devicectl): {d.get('identifier')}")
    checks = [
        (conn.get('pairingState') == 'paired', f"paired with this Mac ({conn.get('pairingState')})"),
        (conn.get('tunnelState') == 'connected', f"connected ({conn.get('transportType') or 'not connected'}, tunnel {conn.get('tunnelState')})"),
        (props.get('developerModeStatus') == 'enabled', f"Developer Mode {props.get('developerModeStatus')}"),
        (props.get('ddiServicesAvailable') is True, 'developer disk image services available'),
    ]
    for passed, text in checks:
        print(f"      {'✓' if passed else '✗'} {text}")
    print('      ? Settings → Developer → Enable UI Automation cannot be read from the Mac; confirm it on the phone.')
PY
