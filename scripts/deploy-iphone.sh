#!/usr/bin/env bash
# Deploy the Praxis phone app (Release build) to a physical iPhone.
# Deploys the Flutter app (apps/praxis-mobile).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKIP_BUILD=0
NO_LAUNCH=0
CLEAN_BUILD=0
TARGET_DEVICE=""

usage() {
  cat <<'EOF'
Usage: ./scripts/deploy-iphone.sh [options]

Deploys the Praxis phone app in Release mode to a connected physical iPhone.

Options:
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
    --help|-h) usage ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

MOBILE_DIR="$REPO_ROOT/apps/praxis-mobile"
IOS_DIR="$MOBILE_DIR/ios"
WORKSPACE="ios/Runner.xcworkspace"; SCHEME="Runner"
DERIVED_DATA="$IOS_DIR/build/device-release"
APP_PATH="$DERIVED_DATA/Build/Products/Release-iphoneos/Runner.app"
# Uses the team's existing Xcode-managed profile, so no Apple account needs to be signed in.
BUNDLE_ID="com.acresweb.praxis.mobile.praxis"
APP_NAME="Praxis"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m  ✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$1"; }
bad()  { printf '\033[31m  ✗ %s\033[0m\n' "$1" >&2; }

# Check dependencies
command -v xcodebuild >/dev/null || { bad "Xcode command-line tools are missing"; exit 1; }
command -v xcrun >/dev/null || { bad "xcrun is missing"; exit 1; }

DEV_JSON=""
BUILD_LOG=""
FLUTTER_LOG=""

cleanup() {
  rm -f "${DEV_JSON:-}" "${BUILD_LOG:-}" "${FLUTTER_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

step "Detecting connected physical iPhone"
DEV_JSON="$(mktemp -t praxis-devices.XXXXXX.json)"

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
paired_offline = []

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
    transport = conn.get("transportType", "unknown")

    if target:
        if target in (udid, core_id, name):
            found = (name, model, ios_ver, udid, core_id, dev_mode, tunnel, transport)
            break
    else:
        if tunnel == "connected":
            # Prefer wired over wireless if multiple devices are connected
            if not found or (transport == "wired" and found[7] != "wired"):
                found = (name, model, ios_ver, udid, core_id, dev_mode, tunnel, transport)
        elif conn.get("pairingState") == "paired":
            paired_offline.append((name, model, ios_ver, udid, core_id, tunnel))

if found:
    print(f"DEVICE_NAME={repr(found[0])}")
    print(f"DEVICE_MODEL={repr(found[1])}")
    print(f"DEVICE_OS={repr(found[2])}")
    print(f"DEVICE_UDID={repr(found[3])}")
    print(f"DEVICE_CORE_ID={repr(found[4])}")
    print(f"DEVICE_MODE={repr(found[5])}")
    print(f"DEVICE_TUNNEL={repr(found[6])}")
    print(f"DEVICE_TRANSPORT={repr(found[7])}")
else:
    if paired_offline:
        print("PAIRED_OFFLINE=1")
        for p in paired_offline:
            print(f"# Paired offline: {p[0]} ({p[1]}, iOS {p[2]}) - {p[4]}")
PY
)

if [ -z "$DEVICE_INFO" ] || echo "$DEVICE_INFO" | grep -q "^PAIRED_OFFLINE=1"; then
  bad "No active physical iPhone found."
  if echo "$DEVICE_INFO" | grep -q "^PAIRED_OFFLINE=1"; then
    echo "  Previously paired devices are currently offline/sleeping:"
    echo "$DEVICE_INFO" | grep "^# Paired offline:" | sed 's/^# /    /'
    echo ""
  fi
  echo "  Please ensure:"
  echo "  1. iPhone is connected by USB, unlocked, and trusted (\"Trust This Computer\")."
  echo "  2. Developer Mode is turned on in Settings → Privacy & Security."
  echo "  3. Device is awake and recognized in Xcode (Window → Devices and Simulators)."
  exit 1
fi

eval "$DEVICE_INFO"

ok "$DEVICE_NAME ($DEVICE_MODEL, iOS $DEVICE_OS)"
echo "    CoreDevice ID:     $DEVICE_CORE_ID"
echo "    Connection:        $DEVICE_TRANSPORT ($DEVICE_TUNNEL)"
if [ -n "$DEVICE_UDID" ]; then
  echo "    UDID:              $DEVICE_UDID"
fi

if [ "$DEVICE_TUNNEL" != "connected" ]; then
  bad "Target device '$DEVICE_NAME' is not reachable (tunnel state: '$DEVICE_TUNNEL')."
  echo "  Please reconnect the device via USB and ensure it is unlocked."
  exit 1
fi

if [ "$DEVICE_MODE" != "enabled" ]; then
  warn "Developer Mode appears to be '$DEVICE_MODE'. Please ensure Developer Mode is enabled in Settings."
fi

# Build
if [ "$SKIP_BUILD" -eq 0 ]; then
  command -v flutter >/dev/null || export PATH="$HOME/flutter/bin:$PATH"
  command -v flutter >/dev/null || { bad "flutter is not on PATH"; exit 1; }
  step "Preparing the Flutter Release build"
  FLUTTER_LOG="$(mktemp -t praxis-flutter-build.XXXXXX.log)"
  if ! (cd "$MOBILE_DIR" && flutter pub get && flutter build ios --release --no-codesign) > "$FLUTTER_LOG" 2>&1; then
    bad "Flutter preparation failed!"
    cat "$FLUTTER_LOG" >&2
    exit 1
  fi

  if [ "$CLEAN_BUILD" -eq 1 ]; then
    step "Cleaning build cache"
    rm -rf "$DERIVED_DATA"
  fi

  step "Compiling iOS Release build for $DEVICE_NAME"
  BUILD_LOG="$(mktemp -t praxis-ios-build.XXXXXX.log)"

  TEAM_ID="${PRAXIS_DEVELOPMENT_TEAM:-}"
  if [ -z "$TEAM_ID" ]; then
    TEAM_ID="WY4B2H77A5"
  fi

  set +e
  (cd "$MOBILE_DIR" && xcodebuild \
    -workspace "$WORKSPACE" \
    -scheme "$SCHEME" \
    -configuration Release \
    -destination "generic/platform=iOS" \
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

# Verify the app and its compiled Dart code
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

[ -f "$APP_PATH/Frameworks/App.framework/App" ] || { bad "Compiled Dart code (App.framework) missing in $APP_PATH"; exit 1; }
ok "Compiled Dart code present"

# Install onto device
step "Installing $APP_NAME on $DEVICE_NAME"
set +e
INSTALL_OUT=$(xcrun devicectl device install app --device "$DEVICE_CORE_ID" "$APP_PATH" 2>&1)
INSTALL_STATUS=$?
set -e

if [ $INSTALL_STATUS -ne 0 ]; then
  # If devicectl failed due to DDI / CoreDevice limitation, try fallback via pymobiledevice3 (installation_proxy)
  if echo "$INSTALL_OUT" | grep -qi "DeveloperDiskImage"; then
    warn "devicectl could not mount Developer Disk Image on this device. Trying direct installation via installation_proxy..."
    PMD_CMD=""
    if command -v uvx >/dev/null 2>&1; then
      PMD_CMD="uvx pymobiledevice3"
    elif command -v pymobiledevice3 >/dev/null 2>&1; then
      PMD_CMD="pymobiledevice3"
    fi

    if [ -n "$PMD_CMD" ]; then
      set +e
      # If device is connected wirelessly, use --native to ride Apple's remotepairingd tunnel
      if [ "$DEVICE_TRANSPORT" = "localNetwork" ] || [ "$DEVICE_TRANSPORT" = "wifi" ]; then
        FALLBACK_OUT=$($PMD_CMD apps install --native "$APP_PATH" 2>&1)
        FALLBACK_STATUS=$?
      else
        FALLBACK_OUT=$($PMD_CMD apps install "$APP_PATH" 2>&1)
        FALLBACK_STATUS=$?
        if [ $FALLBACK_STATUS -ne 0 ]; then
          FALLBACK_OUT=$($PMD_CMD apps install --native "$APP_PATH" 2>&1)
          FALLBACK_STATUS=$?
        fi
      fi
      set -e
      if [ $FALLBACK_STATUS -eq 0 ]; then
        INSTALL_STATUS=0
        ok "Installed $BUNDLE_ID successfully via installation_proxy"
      else
        echo "$FALLBACK_OUT" >&2
      fi
    fi
  fi
fi

if [ $INSTALL_STATUS -ne 0 ]; then
  bad "Failed to install $APP_NAME on $DEVICE_NAME"
  echo "$INSTALL_OUT" >&2
  if echo "$INSTALL_OUT" | grep -qi "DeveloperDiskImage"; then
    echo "" >&2
    warn "Developer Disk Image (DDI) issue detected on the device." >&2
    echo "  This typically occurs when the device runs a newer iOS version or has unmounted debug services." >&2
    echo "  Please open Xcode → Window → Devices and Simulators, select '$DEVICE_NAME', and let Xcode prepare the device." >&2
  elif echo "$INSTALL_OUT" | grep -qi "maximum number of installed apps"; then
    echo "" >&2
    warn "Free developer account limit reached (max 3 sideloaded apps)." >&2
    echo "  Remove an existing app from the device or uninstall via:" >&2
    echo "  xcrun devicectl device uninstall app --device '$DEVICE_CORE_ID' <bundle_id>" >&2
  elif echo "$INSTALL_OUT" | grep -qi "connection was invalidated\|peer is no longer reachable"; then
    echo "" >&2
    warn "Lost connection to $DEVICE_NAME." >&2
    echo "  Please reconnect the iPhone via USB, unlock it, and ensure it stays awake." >&2
  fi
  exit $INSTALL_STATUS
else
  if [ $INSTALL_STATUS -eq 0 ] && ! echo "$INSTALL_OUT" | grep -qi "DeveloperDiskImage"; then
    ok "Installed $BUNDLE_ID successfully"
  fi
fi

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
    elif echo "$LAUNCH_OUT" | grep -qi "DeveloperDiskImage"; then
      warn "Could not launch automatically (device has unmounted debug services)."
      echo "  Tap the Praxis icon on your iPhone home screen to open it."
    else
      warn "Could not launch Praxis automatically."
      echo "  You can open Praxis manually from your iPhone home screen."
    fi
  fi
fi

printf '\n\033[32m✔ Deployment complete!\033[0m\n'
echo "To pair the mobile app with Praxis Desktop:"
echo "  1. Open Desktop Settings → Mobile access → Enable Local network"
echo "  2. Click 'Create pairing invitation' and scan the QR code from the phone"
