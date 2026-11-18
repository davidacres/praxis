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

### Release workflow

A `v*` tag runs `.github/workflows/publish-packages.yml`. It builds the libraries,
stages their compiled output under the repository owner's GitHub namespace, and
publishes the tag version. For this repository the packages are:

- `@davidacres/praxis-core`
- `@davidacres/praxis-mobile-protocol`

The internal workspace names remain `@praxis/core` and `@praxis/mobile-protocol`.
They are not GitHub Packages names: the registry scope must name the owning
GitHub account. Both `GITHUB_TOKEN` (the repository's `.npmrc`) and
`NODE_AUTH_TOKEN` (setup-node's generated configuration) are supplied in CI.

### Manual Publishing

From the repository root, with `GITHUB_TOKEN` set as described above:

```bash
npm run build:core
npm run build:mobile-protocol
package_dir="$(mktemp -d)"
node apps/praxis-desktop/main/scripts/stagePublishedLibraries.cjs "$package_dir" davidacres 0.4.0
npm publish "$package_dir/core"
npm publish "$package_dir/mobile-protocol"
```

Choose the release version explicitly. Do not republish an existing version.
The old `npm run publish:packages` command publishes the internal workspace
names and must not be used for GitHub Packages.

### Using Published Packages

Configure `@davidacres:registry=https://npm.pkg.github.com` and a token with
`read:packages` in your npm configuration, then install the published library:

```bash
npm install @davidacres/praxis-core
```

A consumer retaining the internal import name can use an npm alias:

```json
{
  "dependencies": {
    "@praxis/core": "npm:@davidacres/praxis-core@^0.4.0"
  }
}
```

## Creating Releases

Praxis desktop is a Tauri app. `tauri.conf.json` keeps bundling off so everyday
builds stay fast; `src-tauri/tauri.release.conf.json` switches it on, and
`scripts/package-desktop.mjs` drives it. Tauri cannot cross-package, so each
platform's installer is built on that platform.

### Local build and publish

```bash
npm run release:package              # host platform -> dist/release/
npm run release:publish              # create/update the GitHub Release, upload dist/release/*
```

`release:package` builds the code-intelligence service, runs `tauri build`
with the release config, and copies the installers to `dist/release/`:

| Platform | Artifact |
| --- | --- |
| macOS | `Praxis_<version>_aarch64.dmg` |
| Windows | `Praxis_<version>_x64-setup.exe` (NSIS) |
| Linux | `Praxis_<version>_amd64.AppImage`, `.deb` |

`release:publish` needs an authenticated GitHub CLI (`gh auth login`), requires
the tag to match `version` in `tauri.conf.json` (bump it first), and is safe to
rerun. Pass `--draft` or `--prerelease` after `--`.

### Signing (macOS)

Signing is opt-in through Tauri's standard variables, so nothing is written to
disk. Without them the DMG is **unsigned** and macOS will warn on first open.

```text
APPLE_SIGNING_IDENTITY   Developer ID Application identity already in your keychain
  or APPLE_CERTIFICATE + APPLE_CERTIFICATE_PASSWORD   base64 .p12 (CI)
APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID   enable notarization
```

Do not put these in a tracked file. Windows Authenticode signing is not wired
up yet; add a `bundle.windows.signCommand` to the release config when needed.

### Auto-update

Auto-update is not set up on Tauri: the releases carry installers only, with
no `latest*.yml` manifests. It needs `tauri-plugin-updater` and an updater
signing key (`bundle.createUpdaterArtifacts`).

### Automated Releases (GitHub Actions)

Pushing a version tag runs `build-release.yml`, which packages macOS, Windows
and Linux in parallel and attaches the installers to the GitHub Release:

```bash
git tag v0.6.1
git push origin v0.6.1
```

Actions minutes are billed, so prefer the local path unless you need all three
platforms. `build-release.yml` can also be dispatched with an existing tag.

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

## Using the Built App

The desktop app is released as installers on the [GitHub Releases](https://github.com/davidacres/praxis/releases) page.

### macOS Installation

**Method 1: GUI (Easiest)**
1. Download `Praxis_VERSION_aarch64.dmg` from releases
2. Double-click to mount
3. Drag `Praxis.app` to Applications folder
4. Unmount the DMG

**Method 2: Command Line**
```bash
# Download and install
hdiutil mount Praxis_0.6.1_aarch64.dmg && \
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
