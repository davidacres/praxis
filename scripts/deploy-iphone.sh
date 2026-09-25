#!/usr/bin/env bash
# Deploy the Praxis phone app (Release build) to a physical iPhone.
# Default: the Flutter app (apps/praxis-flutter). --app expo: the Expo app (apps/praxis-mobile).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP="flutter"
SKIP_BUILD=0
NO_LAUNCH=0
CLEAN_BUILD=0
TARGET_DEVICE=""

usage() {
  cat <<'EOF'
Usage: ./scripts/deploy-iphone.sh [options]

Deploys the Praxis phone app in Release mode to a connected physical iPhone.

Options:
  --app flutter|expo  Which app to deploy (default: flutter)
  --skip-build        Skip rebuilding and install the current Release build
  --clean             Clean the build cache before compiling
  --no-launch         Install the app without launching it
  --device <id>       Target device UDID or CoreDevice identifier (default: auto-detect)
  --help, -h          Show this help message

Prerequisites:
  1. iPhone connected via USB, unlocked, and trusted ("Trust This Computer").
  2. Developer Mode enabled (Settings → Privacy & Security → Developer Mode).
  3. Xcode installed with Apple account configured (Xcode → Settings → Accounts).
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --clean) CLEAN_BUILD=1; shift ;;
    --no-launch) NO_LAUNCH=1; shift ;;
    --device) TARGET_DEVICE="$2"; shift 2 ;;
    --app) APP="$2"; shift 2 ;;
    --help|-h) usage ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

case "$APP" in
  flutter)
    MOBILE_DIR="$REPO_ROOT/apps/praxis-flutter"
    IOS_DIR="$MOBILE_DIR/ios"
    WORKSPACE="ios/Runner.xcworkspace"; SCHEME="Runner"
    DERIVED_DATA="$IOS_DIR/build/device-release"
    APP_PATH="$DERIVED_DATA/Build/Products/Release-iphoneos/Runner.app"
    # Uses the team's existing Xcode-managed profile, so no Apple account needs to be signed in.
    BUNDLE_ID="com.acresweb.praxis.mobile.praxis"
    APP_NAME="Praxis Flutter" ;;
  expo)
    MOBILE_DIR="$REPO_ROOT/apps/praxis-mobile"
    IOS_DIR="$MOBILE_DIR/ios"
    WORKSPACE="ios/Praxis.xcworkspace"; SCHEME="Praxis"
    DERIVED_DATA="$IOS_DIR/build/device-release"
    APP_PATH="$DERIVED_DATA/Build/Products/Release-iphoneos/Praxis.app"
    BUNDLE_ID="com.acresweb.praxis.mobile"
    APP_NAME="Praxis" ;;
  *) echo "Unknown --app '$APP' (use flutter or expo)" >&2; exit 1 ;;
esac

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$1"; }
bad()  { printf '\033[31m  ✗ %s\033[0m\n' "$1" >&2; }

# Check dependencies
command -v xcodebuild >/dev/null || { bad "Xcode command-line tools are missing"; exit 1; }
command -v xcrun >/dev/null || { bad "xcrun is missing"; exit 1; }

step "Detecting connected physical iPhone"
DEV_JSON="$(mktemp -t praxis-devices.XXXXXX.json)"
trap 'rm -f "$DEV_JSON"' EXIT

xcrun devicectl list devices --json-output "$DEV_JSON" >/dev/null 2>&1 || {
  bad "xcrun devicectl failed to list devices"
  exit 1
}

DEVICE_INFO=$(/usr/bin/python3 - "$DEV_JSON" "$TARGET_DEVICE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
devices = data.get("result", {}).get("devices", [])
target = sys.argv[2].strip() if len(sys.argv) > 2 else ""

found = None
for d in devices:
    hw = d.get("hardwareProperties", {})
    conn = d.get("connectionProperties", {})
    props = d.get("deviceProperties", {})
    if hw.get("platform") != "iOS" or hw.get("reality") != "physical":
        continue
    udid = hw.get("udid", "")
    core_id = d.get("identifier", "")
    name = props.get("name", "iPhone")
    model = hw.get("marketingName", "iPhone")
    ios_ver = props.get("osVersionNumber", "")
    dev_mode = props.get("developerModeStatus", "")
    tunnel = conn.get("tunnelState", "")

    if target:
        if target in (udid, core_id, name):
            found = (name, model, ios_ver, udid, core_id, dev_mode, tunnel)
            break
    else:
        if tunnel == "connected":
            found = (name, model, ios_ver, udid, core_id, dev_mode, tunnel)
            break
        elif not found and conn.get("pairingState") == "paired":
            found = (name, model, ios_ver, udid, core_id, dev_mode, tunnel)

if found:
    print(f"DEVICE_NAME={repr(found[0])}")
    print(f"DEVICE_MODEL={repr(found[1])}")
    print(f"DEVICE_OS={repr(found[2])}")
    print(f"DEVICE_UDID={repr(found[3])}")
    print(f"DEVICE_CORE_ID={repr(found[4])}")
    print(f"DEVICE_MODE={repr(found[5])}")
    print(f"DEVICE_TUNNEL={repr(found[6])}")
PY
)

if [ -z "$DEVICE_INFO" ]; then
  bad "No physical iPhone found."
  echo "  Please ensure:"
  echo "  1. iPhone is connected by USB, unlocked, and trusted."
  echo "  2. Developer Mode is turned on in Settings → Privacy & Security."
  exit 1
fi

eval "$DEVICE_INFO"

ok "$DEVICE_NAME ($DEVICE_MODEL, iOS $DEVICE_OS)"
echo "    UDID (xcodebuild): $DEVICE_UDID"
echo "    CoreDevice ID:     $DEVICE_CORE_ID"

if [ "$DEVICE_TUNNEL" != "connected" ]; then
  warn "Tunnel state is '$DEVICE_TUNNEL'. If deployment fails, reconnect the USB cable and verify device trust."
fi

if [ "$DEVICE_MODE" != "enabled" ]; then
  warn "Developer Mode appears to be '$DEVICE_MODE'. Please ensure Developer Mode is enabled in Settings."
fi

# Build
if [ "$SKIP_BUILD" -eq 0 ]; then
  if [ "$APP" = expo ]; then
    step "Building core packages"
    (cd "$REPO_ROOT" && npm run build:core && npm run build:mobile-protocol)
  else
    command -v flutter >/dev/null || export PATH="$HOME/flutter/bin:$PATH"
    command -v flutter >/dev/null || { bad "flutter is not on PATH"; exit 1; }
    step "Preparing the Flutter Release build"
    (cd "$MOBILE_DIR" && flutter pub get >/dev/null && flutter build ios --release --no-codesign >/dev/null)
  fi

  if [ "$CLEAN_BUILD" -eq 1 ]; then
    step "Cleaning build cache"
    rm -rf "$DERIVED_DATA"
  fi

  step "Compiling iOS Release build for $DEVICE_NAME"
  BUILD_LOG="$(mktemp -t praxis-ios-build.XXXXXX.log)"
  trap 'rm -f "$DEV_JSON" "$BUILD_LOG"' EXIT

  TEAM_ID="${PRAXIS_DEVELOPMENT_TEAM:-}"
  if [ -z "$TEAM_ID" ]; then
    TEAM_ID=$(node -p 'try { require("./apps/praxis-mobile/app.json").expo.ios.appleTeamId || "" } catch(e){ "" }')
  fi
  if [ -z "$TEAM_ID" ]; then
    TEAM_ID="WY4B2H77A5"
  fi

  set +e
  (cd "$MOBILE_DIR" && xcodebuild \
    -workspace "$WORKSPACE" \
    -scheme "$SCHEME" \
    -configuration Release \
    -destination "id=$DEVICE_UDID" \
    -derivedDataPath "$DERIVED_DATA" \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    build) > "$BUILD_LOG" 2>&1
  BUILD_STATUS=$?
  set -e

  if [ $BUILD_STATUS -ne 0 ]; then
    bad "iOS Release build failed!"
    echo "--- Build errors ---" >&2
    grep -E 'error:' "$BUILD_LOG" | head -10 >&2 || tail -20 "$BUILD_LOG" >&2
    echo "Full log: $BUILD_LOG" >&2
    exit $BUILD_STATUS
  fi
  ok "Release build succeeded"
fi

# Verify the app and embedded JavaScript bundle
step "Verifying Release bundle"
if [ ! -d "$APP_PATH" ]; then
  bad "$(basename "$APP_PATH") not found at $APP_PATH"
  exit 1
fi

INSTALLED_BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP_PATH/Info.plist" 2>/dev/null || echo "$BUNDLE_ID")
if [ "$INSTALLED_BUNDLE_ID" != "$BUNDLE_ID" ]; then
  bad "Expected CFBundleIdentifier '$BUNDLE_ID', but found '$INSTALLED_BUNDLE_ID'"
  exit 1
fi

if [ "$APP" = expo ]; then
JS_BUNDLE="$APP_PATH/main.jsbundle"
if [ ! -f "$JS_BUNDLE" ]; then
  bad "main.jsbundle missing in $APP_PATH!"
  bad "Physical iPhone requires embedded JavaScript bundle in Release mode to run without Metro."
  exit 1
fi

BUNDLE_SIZE=$(wc -c < "$JS_BUNDLE" | tr -d ' ')
if [ "$BUNDLE_SIZE" -lt 100000 ]; then
  bad "main.jsbundle is unexpectedly small ($BUNDLE_SIZE bytes)."
  exit 1
fi
ok "Embedded JS bundle verified ($(( BUNDLE_SIZE / 1024 )) KB)"
else
  [ -f "$APP_PATH/Frameworks/App.framework/App" ] || { bad "Compiled Dart code (App.framework) missing in $APP_PATH"; exit 1; }
  ok "Compiled Dart code present"
fi

# Install onto device
step "Installing $APP_NAME on $DEVICE_NAME"
xcrun devicectl device install app --device "$DEVICE_CORE_ID" "$APP_PATH"
ok "Installed $BUNDLE_ID successfully"

# Launch app
if [ "$NO_LAUNCH" -eq 0 ]; then
  step "Launching $APP_NAME on $DEVICE_NAME"
  set +e
  LAUNCH_OUT=$(xcrun devicectl device process launch --device "$DEVICE_CORE_ID" --terminate-existing "$BUNDLE_ID" 2>&1)
  LAUNCH_STATUS=$?
  set -e

  if [ $LAUNCH_STATUS -eq 0 ]; then
    ok "$APP_NAME launched on $DEVICE_NAME!"
  else
    if echo "$LAUNCH_OUT" | grep -qi "Locked"; then
      warn "Praxis installed successfully, but could not launch because $DEVICE_NAME is locked."
      echo "  Please unlock your iPhone and tap Praxis on the home screen."
    else
      warn "Could not launch Praxis automatically: $LAUNCH_OUT"
      echo "  You can open Praxis manually from your iPhone home screen."
    fi
  fi
fi

printf '\n\033[32m✔ Deployment complete!\033[0m\n'
echo "To pair the mobile app with Praxis Desktop:"
echo "  1. Open Desktop Settings → Mobile access → Enable Local network"
echo "  2. Click 'Create pairing invitation' and scan the QR code from the phone"
