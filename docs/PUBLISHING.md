# Publishing Praxis Packages and Releases

This document explains how to publish Praxis packages to GitHub Packages and create releases.

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

### Manual Release

To create a release and upload the installer:

```bash
# Build the installer first
npm run app:installer:mac

# Create the release (requires GITHUB_TOKEN)
npm run release:create

# Upload the built installer
gh release upload v0.3.0 apps/praxis-desktop/main/dist/Praxis-0.3.0-arm64.dmg
```

### Automated Releases (GitHub Actions)

When GitHub Actions becomes available, releases will be created automatically when you push a version tag:

```bash
git tag v0.4.0
git push origin v0.4.0
```

This triggers:
1. `publish-packages.yml` - Publishes packages to GitHub Packages
2. `build-release.yml` - Builds installers on macOS and Windows, uploads to release

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
