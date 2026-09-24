#!/bin/bash
# Generates and builds the driver.
#   setup.sh                      first connected iPhone (or PRAXIS_DEVICE_ID)
#   setup.sh --simulator [name]   a booted simulator, else the first matching one (booted for you)
# Re-run after editing DriverTests.swift or changing device.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$DRIVER_DIR"

TARGET=device
if [ "${1:-}" = "--simulator" ]; then TARGET=simulator; SIM_NAME="${2:-}"; fi

if [ -z "${PRAXIS_DRIVER_TEAM:-}" ]; then
  # Sign with the same team as the Praxis app when this copy sits in the repo.
  for project in "${PRAXIS_IOS_PROJECT:-}" "$DRIVER_DIR/../../ios/Praxis.xcodeproj"; do
    if [ -n "$project" ] && [ -f "$project/project.pbxproj" ]; then
      PRAXIS_DRIVER_TEAM=$(grep -m1 -oE 'DEVELOPMENT_TEAM = [A-Z0-9]+' "$project/project.pbxproj" | awk '{print $3}' || true)
      break
    fi
  done
fi
if [ "$TARGET" = device ] && [ -z "${PRAXIS_DRIVER_TEAM:-}" ]; then
  echo "Set PRAXIS_DRIVER_TEAM (Apple development team id) or PRAXIS_IOS_PROJECT (path to Praxis.xcodeproj)." >&2
  exit 1
fi
export PRAXIS_DRIVER_TEAM="${PRAXIS_DRIVER_TEAM:-}"

POD_GEMS=$(ls -d /opt/homebrew/Cellar/cocoapods/*/libexec /usr/local/Cellar/cocoapods/*/libexec 2>/dev/null | tail -1 || true)
RUBY=/opt/homebrew/opt/ruby/bin/ruby
[ -x "$RUBY" ] || RUBY=ruby
rm -rf PraxisDriver.xcodeproj
if ! GEM_HOME="${POD_GEMS:-${GEM_HOME:-}}" "$RUBY" -e 'require "xcodeproj"' 2> /dev/null; then
  echo "The xcodeproj Ruby gem is missing. Install CocoaPods (brew install cocoapods) or: gem install xcodeproj" >&2
  exit 1
fi
GEM_HOME="${POD_GEMS:-${GEM_HOME:-}}" "$RUBY" generate.rb

rm -f "$RUN_DIR/device-id"
if [ "$TARGET" = simulator ]; then
  DEVICE=$(simulator_udid "${SIM_NAME:-}") || { echo "No simulator matches '${SIM_NAME:-iPhone}'. See: xcrun simctl list devices available" >&2; exit 1; }
else
  DEVICE=$(driver_device_id)
  [ -n "$DEVICE" ] || { echo "No connected iPhone found. Run preflight.sh for details." >&2; exit 1; }
fi
echo "$DEVICE" > "$RUN_DIR/device-id"

xcodebuild build-for-testing -project PraxisDriver.xcodeproj -scheme DriverUITests \
  -destination "id=$DEVICE" -derivedDataPath "$RUN_DIR/dd" -allowProvisioningUpdates > "$RUN_DIR/build.log" 2>&1 \
  || { grep -E 'error:' "$RUN_DIR/build.log" | head -5; echo "Build failed — see $RUN_DIR/build.log" >&2; exit 1; }
echo "Driver ready for $TARGET $DEVICE."
