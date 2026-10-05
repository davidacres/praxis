#!/usr/bin/env bash
# Praxis one-line installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/davidacres/praxis/main/scripts/install.sh | bash
#
# Options (pass after -- when piping to bash):
#   curl -fsSL ... | bash -s -- [options]
#     --version <tag>   Install specific version (e.g. v0.4.1 or 0.4.1)
#     --user            Install to ~/Applications (macOS) or ~/.local/bin (Linux) without sudo
#     --launch          Open Praxis after successful installation
#     --help, -h        Show help message

set -euo pipefail

REPO="davidacres/praxis"
TARGET_VERSION=""
INSTALL_USER=0
LAUNCH_AFTER=0

# Colors (if terminal supports them)
if [ -t 1 ]; then
  BOLD="\033[1m"
  GREEN="\033[1;32m"
  BLUE="\033[1;34m"
  YELLOW="\033[1;33m"
  RED="\033[1;31m"
  DIM="\033[2m"
  RESET="\033[0m"
else
  BOLD=""
  GREEN=""
  BLUE=""
  YELLOW=""
  RED=""
  DIM=""
  RESET=""
fi

log_info() { printf "${BLUE}==>${RESET} ${BOLD}%s${RESET}\n" "$*"; }
log_step() { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
log_warn() { printf "${YELLOW}Warning:${RESET} %s\n" "$*"; }
log_error() { printf "${RED}Error:${RESET} %s\n" "$*" >&2; }

usage() {
  cat <<EOF
Praxis Installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/davidacres/praxis/main/scripts/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/davidacres/praxis/main/scripts/install.sh | bash -s -- [options]

Options:
  --version <v>   Install specific version (e.g. 0.4.1 or v0.4.1)
  --user          Install locally without root/sudo:
                    macOS: ~/Applications/Praxis.app
                    Linux: ~/.local/bin/praxis
  --launch        Automatically launch Praxis after installation
  --help, -h      Show this help message
EOF
  exit 0
}

# Parse options
while [ $# -gt 0 ]; do
  case "$1" in
    --version) TARGET_VERSION="$2"; shift 2 ;;
    --user) INSTALL_USER=1; shift ;;
    --launch) LAUNCH_AFTER=1; shift ;;
    --help|-h) usage ;;
    *) log_error "Unknown option: $1"; exit 1 ;;
  esac
done

# Detect operating system
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux" ;;
  CYGWIN*|MINGW*|MSYS*) PLATFORM="windows" ;;
  *)
    log_error "Unsupported operating system: $OS"
    printf "Please download manually from: https://github.com/%s/releases/latest\n" "$REPO"
    exit 1
    ;;
esac

# Normalize architecture
case "$ARCH" in
  arm64|aarch64) ARCH_FAMILY="arm64" ;;
  x86_64|amd64)  ARCH_FAMILY="x64" ;;
  *)
    log_error "Unsupported processor architecture: $ARCH"
    exit 1
    ;;
esac

# Handle Windows early
if [ "$PLATFORM" = "windows" ]; then
  log_info "Detected Windows ($ARCH_FAMILY)"
  printf "\nFor Windows, run in PowerShell:\n"
  printf "  ${BOLD}irm https://raw.githubusercontent.com/%s/main/scripts/install.ps1 | iex${RESET}\n\n" "$REPO"
  printf "Or download the installer directly:\n"
  printf "  ${BOLD}https://github.com/%s/releases/latest${RESET}\n\n" "$REPO"
  exit 0
fi

# Resolve version
if [ -z "$TARGET_VERSION" ]; then
  log_info "Finding latest release of Praxis..."
  # Resolve latest tag via GitHub redirect (avoids API rate limits)
  REDIRECT_URL="$(curl -fsSIL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest" 2>/dev/null || true)"
  TAG="$(basename "$REDIRECT_URL")"
  if [ -z "$TAG" ] || [ "$TAG" = "latest" ]; then
    # Fallback to GitHub API if redirect did not yield tag
    TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | grep '"tag_name":' | head -n 1 | cut -d '"' -f 4 || true)"
  fi
  if [ -z "$TAG" ]; then
    log_error "Could not determine latest version. Please specify --version <version>."
    exit 1
  fi
else
  TAG="$TARGET_VERSION"
  [[ "$TAG" =~ ^v ]] || TAG="v$TAG"
fi

VERSION="${TAG#v}"
log_step "Selected version: ${BOLD}${TAG}${RESET}"

# Temp working directory
TMP_DIR="$(mktemp -d -t praxis-install-XXXXXX)"
cleanup() {
  if [ -n "${MOUNT_DIR:-}" ] && [ -d "$MOUNT_DIR" ]; then
    hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
    rmdir "$MOUNT_DIR" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

# Installation per platform
if [ "$PLATFORM" = "darwin" ]; then
  # macOS Installation
  ASSET_NAME="Praxis-${VERSION}-arm64.dmg"
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET_NAME}"

  # Determine target directory
  if [ "$INSTALL_USER" -eq 1 ]; then
    DEST_DIR="$HOME/Applications"
    USE_SUDO=""
  else
    DEST_DIR="/Applications"
    if [ -w "$DEST_DIR" ]; then
      USE_SUDO=""
    else
      if command -v sudo >/dev/null 2>&1; then
        USE_SUDO="sudo"
      else
        log_warn "Cannot write to /Applications and sudo is unavailable. Installing to ~/Applications."
        DEST_DIR="$HOME/Applications"
        USE_SUDO=""
      fi
    fi
  fi
  mkdir -p "$DEST_DIR"

  log_info "Downloading Praxis ${TAG} for macOS (${ARCH_FAMILY})..."
  DMG_PATH="${TMP_DIR}/${ASSET_NAME}"
  if ! curl -fL --progress-bar -o "$DMG_PATH" "$DOWNLOAD_URL"; then
    log_error "Failed to download ${DOWNLOAD_URL}"
    exit 1
  fi
  log_step "Download complete"

  log_info "Installing Praxis to ${DEST_DIR}/Praxis.app..."
  MOUNT_DIR="$(mktemp -d -t praxis-mnt-XXXXXX)"
  hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_DIR" -nobrowse -quiet

  if [ ! -d "$MOUNT_DIR/Praxis.app" ]; then
    log_error "Praxis.app not found inside DMG"
    exit 1
  fi

  if [ -d "${DEST_DIR}/Praxis.app" ]; then
    log_step "Removing previous installation..."
    $USE_SUDO rm -rf "${DEST_DIR}/Praxis.app"
  fi

  $USE_SUDO cp -R "$MOUNT_DIR/Praxis.app" "$DEST_DIR/"
  hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
  MOUNT_DIR=""

  # Clear gatekeeper quarantine attribute if present
  $USE_SUDO xattr -dr com.apple.quarantine "${DEST_DIR}/Praxis.app" 2>/dev/null || true
  log_step "Installed to ${BOLD}${DEST_DIR}/Praxis.app${RESET}"

  printf "\n${GREEN}${BOLD}✓ Praxis ${TAG} installed successfully!${RESET}\n"
  printf "You can open it from Spotlight or run:\n"
  printf "  ${BOLD}open -a Praxis${RESET}\n\n"

  if [ "$LAUNCH_AFTER" -eq 1 ]; then
    log_info "Launching Praxis..."
    open -a "${DEST_DIR}/Praxis.app"
  fi

elif [ "$PLATFORM" = "linux" ]; then
  # Linux Installation
  ASSET_NAME="Praxis-${VERSION}-x86_64.AppImage"
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET_NAME}"

  if [ "$INSTALL_USER" -eq 1 ] || [ ! -w "/usr/local/bin" ]; then
    BIN_DIR="$HOME/.local/bin"
  else
    BIN_DIR="/usr/local/bin"
  fi
  mkdir -p "$BIN_DIR"

  log_info "Downloading Praxis ${TAG} for Linux..."
  TARGET_BIN="${BIN_DIR}/praxis"
  if ! curl -fL --progress-bar -o "$TARGET_BIN" "$DOWNLOAD_URL"; then
    log_error "Failed to download ${DOWNLOAD_URL}"
    exit 1
  fi
  chmod +x "$TARGET_BIN"
  log_step "Installed binary to ${BOLD}${TARGET_BIN}${RESET}"

  # Desktop launcher entry
  APPLICATIONS_DIR="$HOME/.local/share/applications"
  if [ -d "$APPLICATIONS_DIR" ] || [ -d "$HOME/.local/share" ]; then
    mkdir -p "$APPLICATIONS_DIR"
    DESKTOP_ENTRY="${APPLICATIONS_DIR}/praxis.desktop"
    cat > "$DESKTOP_ENTRY" <<EOF
[Desktop Entry]
Name=Praxis
Comment=The workspace where boards, AI agents and delivery meet
Exec=${TARGET_BIN} %U
Terminal=false
Type=Application
Categories=Development;ProjectManagement;
StartupWMClass=praxis
EOF
    chmod +x "$DESKTOP_ENTRY" 2>/dev/null || true
    log_step "Registered desktop application launcher"
  fi

  printf "\n${GREEN}${BOLD}✓ Praxis ${TAG} installed successfully!${RESET}\n"
  if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
    printf "${YELLOW}Note:${RESET} ${BIN_DIR} is not in your PATH. Add it with:\n"
    printf "  ${BOLD}export PATH=\"\$PATH:%s\"${RESET}\n\n" "$BIN_DIR"
  fi
  printf "Run Praxis with:\n"
  printf "  ${BOLD}praxis${RESET}\n\n"

  if [ "$LAUNCH_AFTER" -eq 1 ]; then
    log_info "Launching Praxis..."
    "$TARGET_BIN" &
  fi
fi
