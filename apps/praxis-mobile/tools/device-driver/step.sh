#!/bin/bash
# Runs one driver step on the phone and leaves its results in .run/:
#   tree.txt   accessibility tree after the actions
#   screen.png screenshot after the actions
#   run.log    full xcodebuild output
# Usage: step.sh "<action>;;<action>..." [settle-seconds]
set -uo pipefail
source "$(dirname "$0")/lib.sh"
cd "$DRIVER_DIR"
[ -d "$RUN_DIR/dd" ] || { echo "Run setup.sh first." >&2; exit 1; }
DEVICE=$(driver_device_id)

rm -rf "$RUN_DIR/out.xcresult" "$RUN_DIR/shots" "$RUN_DIR/screen.png"
mkdir -p "$RUN_DIR/shots"
TEST_RUNNER_DRIVER_ACTIONS="${1:-}" \
TEST_RUNNER_DRIVER_SETTLE="${2:-1.5}" \
TEST_RUNNER_DRIVER_BUNDLE_ID="${PRAXIS_APP_BUNDLE_ID:-com.acresweb.praxis.mobile}" \
  xcodebuild test-without-building -project PraxisDriver.xcodeproj -scheme DriverUITests \
  -destination "id=$DEVICE" -derivedDataPath "$RUN_DIR/dd" -resultBundlePath "$RUN_DIR/out.xcresult" > "$RUN_DIR/run.log" 2>&1
status=$?
grep -E '^DRIVER (tapped|NOT FOUND|typed|unknown)' "$RUN_DIR/run.log"
sed -n '/DRIVER_TREE_BEGIN/,/DRIVER_TREE_END/p' "$RUN_DIR/run.log" | grep -vE 'DRIVER_TREE|^\s*$' > "$RUN_DIR/tree.txt"
xcrun xcresulttool export attachments --path "$RUN_DIR/out.xcresult" --output-path "$RUN_DIR/shots" > /dev/null 2>&1
shot=$(ls "$RUN_DIR"/shots/*.png 2>/dev/null | head -1)
[ -n "$shot" ] && cp "$shot" "$RUN_DIR/screen.png"
if [ $status -ne 0 ]; then grep -E 'error:' "$RUN_DIR/run.log" | head -3; fi
exit $status
