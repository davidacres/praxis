#!/bin/bash
# Generates and builds the driver for the connected iPhone. Re-run after editing
# DriverTests.swift or when switching devices.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$DRIVER_DIR"

if [ -z "${PRAXIS_DRIVER_TEAM:-}" ]; then
  # Sign with the same team as the Praxis app.
  PRAXIS_DRIVER_TEAM=$(grep -m1 -oE 'DEVELOPMENT_TEAM = [A-Z0-9]+' "$DRIVER_DIR/../../ios/Praxis.xcodeproj/project.pbxproj" | awk '{print $3}')
fi
[ -n "$PRAXIS_DRIVER_TEAM" ] || { echo "Set PRAXIS_DRIVER_TEAM to your Apple development team id." >&2; exit 1; }
export PRAXIS_DRIVER_TEAM

POD_GEMS=$(ls -d /opt/homebrew/Cellar/cocoapods/*/libexec 2>/dev/null | tail -1 || true)
RUBY=/opt/homebrew/opt/ruby/bin/ruby
[ -x "$RUBY" ] || RUBY=ruby
rm -rf PraxisDriver.xcodeproj
GEM_HOME="${POD_GEMS:-${GEM_HOME:-}}" "$RUBY" generate.rb

rm -f "$RUN_DIR/device-id"
DEVICE=$(driver_device_id)
[ -n "$DEVICE" ] || { echo "No connected iPhone found. Unlock it, trust this Mac, and enable UI Automation (Settings → Developer)." >&2; exit 1; }
echo "$DEVICE" > "$RUN_DIR/device-id"

xcodebuild build-for-testing -project PraxisDriver.xcodeproj -scheme DriverUITests \
  -destination "id=$DEVICE" -derivedDataPath "$RUN_DIR/dd" -allowProvisioningUpdates > "$RUN_DIR/build.log" 2>&1 \
  || { grep -E 'error:' "$RUN_DIR/build.log" | head -5; echo "Build failed — see $RUN_DIR/build.log" >&2; exit 1; }
echo "Driver ready for device $DEVICE."
