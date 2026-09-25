# Shared by setup.sh, step.sh and preflight.sh.
DRIVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${PRAXIS_DRIVER_RUN_DIR:-$DRIVER_DIR/.run}"
mkdir -p "$RUN_DIR"
PRAXIS_APP_BUNDLE_ID="${PRAXIS_APP_BUNDLE_ID:-com.acresweb.praxis.mobile.praxis}"

# The xcodebuild destination id: PRAXIS_DEVICE_ID, else the one recorded by
# setup.sh, else the first connected physical iPhone.
driver_device_id() {
  if [ -n "${PRAXIS_DEVICE_ID:-}" ]; then echo "$PRAXIS_DEVICE_ID"; return; fi
  if [ -s "$RUN_DIR/device-id" ]; then cat "$RUN_DIR/device-id"; return; fi
  first_physical_udid
}

# UDID of the first physical iPhone CoreDevice reports as connected.
first_physical_udid() {
  local json="$RUN_DIR/devices.json"
  xcrun devicectl list devices --json-output "$json" > /dev/null 2>&1 || return 0
  /usr/bin/python3 - "$json" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1])).get('result', {}).get('devices', [])
for d in devices:
    hw, conn = d.get('hardwareProperties', {}), d.get('connectionProperties', {})
    if hw.get('platform') == 'iOS' and hw.get('reality') == 'physical' and conn.get('tunnelState') in ('connected', 'disconnected') and conn.get('pairingState') == 'paired':
        if d.get('deviceProperties', {}).get('bootState', 'booted') == 'booted' and hw.get('udid'):
            print(hw['udid']); break
PY
}

# UDID of a simulator: a booted one, else the named one (booted on demand).
simulator_udid() {
  local wanted="${1:-}"
  if [ -z "$wanted" ]; then
    xcrun simctl list devices booted | grep -oE 'iPhone[^(]*\(([0-9A-F-]{36})\) \(Booted\)' | head -1 | grep -oE '[0-9A-F-]{36}' && return
    wanted="iPhone"
  fi
  local udid
  udid=$(xcrun simctl list devices available | grep -F "$wanted" | grep -oE '[0-9A-F-]{36}' | head -1)
  [ -n "$udid" ] || return 1
  xcrun simctl boot "$udid" > /dev/null 2>&1 || true
  echo "$udid"
}

is_simulator() {
  xcrun simctl list devices | grep -q "$1"
}
