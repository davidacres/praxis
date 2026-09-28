# Publishing Praxis Packages and Releases

This document explains how to publish Praxis libraries to GitHub Packages and
ship the Praxis Desktop installers through GitHub Releases.

## Publishing Packages to GitHub Packages

### Setup (one-time)

1. Create a GitHub Personal Access Token with `write:packages` scope
2. Set the token in your environment:
   ```bash
   export GITHUB_TOKEN=your_github_token
   ```

### Manual Publishing

To publish packages manually:

```bash
npm run publish:packages
```

This publishes:
- `@praxis/core` 
- `@praxis/mobile-protocol`

### Using Published Packages

Once published, you can install the packages in another project:

```bash
# Create .npmrc in your project
echo "@praxis:registry=https://npm.pkg.github.com" >> .npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> .npmrc

# Install the package
npm install @praxis/core
```

Or use it in your `package.json`:

```json
{
  "dependencies": {
    "@praxis/core": "^0.0.0"
  }
}
```

## Creating Releases

### Local signed builds

The local scripts pass signing credentials directly to electron-builder and do
not write passwords or certificates into the repository.

For macOS, export a password-protected **Developer ID Application** certificate
and its private key from Keychain Access as a `.p12`, then run:

```bash
npm run release:local:mac -- --certificate /secure/path/DeveloperIDApplication.p12
```

The script prompts for the `.p12` password, Apple ID, Team ID, and Apple
app-specific password. Password input is hidden. It builds a signed and
notarized DMG, the ZIP required by Squirrel.Mac, their blockmaps, and
`latest-mac.yml`.

For Windows, export or obtain a password-protected Authenticode `.pfx`, then
run from PowerShell on Windows:

```powershell
npm run release:local:win -- -Certificate C:\secure\PraxisSigning.pfx
```

The password is prompted for as a secure value. On macOS or Linux,
electron-builder can also sign a cross-built Windows installer with:

```bash
./scripts/build-signed-installer.sh --target win --certificate /secure/path/PraxisSigning.pfx
```

All prompts can be bypassed for an existing secure shell session by exporting
electron-builder's standard variables:

```text
macOS:  CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID,
        APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
Windows: WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD
```

Do not put these values in a tracked file. `.env` files are ignored, but an OS
keychain or password manager is preferable for long-lived credentials.

After reviewing the artifacts, publish the current platform through your
authenticated GitHub CLI session:

```bash
gh auth login
npm run release:local:upload -- --target mac
```

The uploader requires the release tag to match the desktop package version,
creates the GitHub Release when necessary, and safely replaces matching assets
when rerun. Use `--target win` or `--target linux` for those platforms.

### Manual Release

To create a release and upload the installer:

```bash
# Build the installers and update metadata first
npm run dist:mac --workspace=@praxis/desktop-main

# Create the release (requires GITHUB_TOKEN)
npm run release:create

# Upload the built installer
gh release upload v0.3.0 \
  apps/praxis-desktop/main/dist/Praxis-0.3.0-arm64.dmg \
  apps/praxis-desktop/main/dist/Praxis-0.3.0-arm64.zip \
  apps/praxis-desktop/main/dist/latest-mac.yml
```

### Automated Releases (GitHub Actions)

When GitHub Actions becomes available, releases will be created automatically when you push a version tag:

```bash
git tag v0.4.0
git push origin v0.4.0
```

This triggers:

1. `publish-packages.yml` publishes the shared libraries to GitHub Packages.
2. `build-release.yml` builds the signed/notarized installers and updater
   metadata on macOS, Windows, and Linux, then creates the GitHub Release and
   uploads every artifact from one release job.

The release contains the native installers plus `latest.yml`,
`latest-mac.yml`, and `latest-linux.yml`. The macOS release also contains a ZIP
because Squirrel.Mac uses it for automatic updates; users still install Praxis
from the DMG.

## Package Versions

To update package versions before publishing:

```bash
# Update version in packages
npm version patch --workspace=@praxis/core
npm version patch --workspace=@praxis/mobile-protocol

# Commit and tag
git add .
git commit -m "chore: bump package versions"
git tag v0.4.0
git push origin main --tags
```

## Using the Built Electron App

The Electron app is released as installers on the [GitHub Releases](https://github.com/davidacres/praxis/releases) page.

### macOS Installation

**Method 1: GUI (Easiest)**
1. Download `Praxis-VERSION-arm64.dmg` from releases
2. Double-click to mount
3. Drag `Praxis.app` to Applications folder
4. Unmount the DMG

**Method 2: Command Line**
```bash
# Download and install
hdiutil mount Praxis-0.3.0-arm64.dmg && \
cp -r /Volumes/Praxis/Praxis.app /Applications/ && \
hdiutil unmount /Volumes/Praxis

# Launch
open /Applications/Praxis.app
```

### Windows Installation

**Method 1: GUI (Easiest)**
1. Download `Praxis-VERSION-setup.exe` from releases
2. Double-click to run installer
3. Follow the installation wizard
4. App launches after installation

**Method 2: Command Line**
```bash
# Download and install silently
powershell -NoProfile -ExecutionPolicy Bypass -Command `
  Invoke-WebRequest -Uri 'https://github.com/davidacres/praxis/releases/download/v0.3.0/Praxis-0.3.0-setup.exe' `
  -OutFile 'Praxis-0.3.0-setup.exe'; `
  & '.\Praxis-0.3.0-setup.exe' /S; `
  Remove-Item '.\Praxis-0.3.0-setup.exe'

# Or run with UI (default)
& '.\Praxis-0.3.0-setup.exe'
```

The installer creates:
- Desktop shortcut
- Start Menu entry
- Uninstaller in Control Panel

### Linux Installation

**Method 1: AppImage (Universal)**
1. Download `Praxis-VERSION-ARCH.AppImage` from releases
2. Make it executable:
   ```bash
   chmod +x Praxis-*.AppImage
   ```
3. Launch:
   ```bash
   ./Praxis-*.AppImage
   ```

**Method 2: Debian / Ubuntu (.deb)**
1. Download `Praxis-VERSION-ARCH.deb` from releases
2. Install with apt or dpkg:
   ```bash
   sudo apt install ./Praxis-*.deb
   # or: sudo dpkg -i Praxis-*.deb
   ```
3. Launch `praxis` from your terminal or application launcher.
