# Shared by setup.sh and step.sh.
DRIVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$DRIVER_DIR/.run"
mkdir -p "$RUN_DIR"

# The connected iPhone's xcodebuild id: PRAXIS_DEVICE_ID, else the one recorded by
# setup.sh, else the first physical iOS destination xcodebuild reports.
driver_device_id() {
  if [ -n "${PRAXIS_DEVICE_ID:-}" ]; then echo "$PRAXIS_DEVICE_ID"; return; fi
  if [ -s "$RUN_DIR/device-id" ]; then cat "$RUN_DIR/device-id"; return; fi
  xcodebuild -project "$DRIVER_DIR/PraxisDriver.xcodeproj" -scheme DriverUITests -showdestinations 2>/dev/null \
    | grep -E 'platform:iOS, arch:[^,]+, id:' | grep -v placeholder | head -1 | sed -E 's/.*id:([^,]+),.*/\1/'
}
