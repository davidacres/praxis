<#
.SYNOPSIS
  Build the Praxis Electron desktop app and package it as a branded Windows
  NSIS installer via electron-builder.

.DESCRIPTION
  Orchestrates the full pipeline:

    1. packages/core          -> tsc, produces out/ with the runtime library
    2. packages/frontend      -> vite build, produces dist/ that the renderer loads
    3. packages/electron-app  -> tsc, produces out/main + out/preload
    4. copy-renderer step     -> packages/frontend/dist -> packages/electron-app/renderer
                                 (so `loadFile('../../renderer/index.html')` resolves
                                 inside the asar — see packages/electron-app/src/main/index.ts)
    5. electron-builder       -> produces packages/electron-app/dist/Praxis-*-setup.exe

  The setup executable lands in packages/electron-app/dist/ and can be
  double-clicked to install Praxis.

.PARAMETER SkipBuild
  Skip the workspace compile/copy steps and run electron-builder against the
  already-built artifacts. Fails fast if any required input is missing.

.PARAMETER Target
  Optional electron-builder target override. Defaults to the NSIS target
  configured in packages/electron-app/package.json (build.win.target). Pass
  'nsis' or 'portable' to produce alternative formats, or 'dir' to produce
  an unpacked directory (useful for smoke-testing the launcher without
  installing).

.EXAMPLE
  npm run app:dist

.EXAMPLE
  pwsh ./scripts/build-app.ps1

.EXAMPLE
  pwsh ./scripts/build-app.ps1 -Target portable

.EXAMPLE
  pwsh ./scripts/build-app.ps1 -SkipBuild -Target dir
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [string]$Target
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$core = Join-Path $repoRoot 'packages/core'
$frontend = Join-Path $repoRoot 'packages/frontend'
$electronApp = Join-Path $repoRoot 'packages/electron-app'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  + $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }

# Electron exits 9 on flags it does not accept from NODE_OPTIONS (--use-system-ca
# is the usual culprit in this org's shells), so every child runs without it.
$env:NODE_OPTIONS = ''

function Invoke-Npm($workingDir, $scriptName) {
  Push-Location $workingDir
  try {
    npm run $scriptName
    if ($LASTEXITCODE -ne 0) {
      throw "npm run $scriptName failed in $workingDir (exit $LASTEXITCODE)"
    }
  } finally {
    Pop-Location
  }
}

function Assert-Built($path, $hint) {
  if (-not (Test-Path $path)) {
    throw "Missing $path - run without -SkipBuild ($hint)."
  }
}

if ($SkipBuild) {
  Write-Step 'Skipping build; checking existing output'
  Assert-Built (Join-Path $core 'out/index.js') 'core is not compiled'
  Assert-Built (Join-Path $frontend 'dist/index.html') 'frontend is not built'
  Assert-Built (Join-Path $electronApp 'out/main/index.js') 'electron-app is not compiled'
  Write-Ok 'Existing build output looks complete'

  # Refreshing renderer/ from frontend/dist is cheap — always run it so the
  # -SkipBuild path still tracks any manual frontend rebuilds.
  Write-Step 'Refreshing renderer/ from frontend/dist'
  Invoke-Npm $electronApp 'copy-renderer'
} else {
  Write-Step 'Compiling packages/core'
  Invoke-Npm $core 'compile'
  Write-Ok 'core -> out/'

  Write-Step 'Building packages/frontend'
  Invoke-Npm $frontend 'build'
  Write-Ok 'frontend -> dist/'

  Write-Step 'Compiling packages/electron-app'
  Invoke-Npm $electronApp 'compile'
  Write-Ok 'electron-app -> out/'

  Write-Step 'Copying frontend/dist into electron-app/renderer'
  Invoke-Npm $electronApp 'copy-renderer'
  Write-Ok 'renderer ready for asar packaging'
}

if ($Target) {
  $ebArgs = @('--win', $Target)
  Write-Step "Running electron-builder (target: $Target)"
} else {
  $ebArgs = @()
  Write-Step 'Running electron-builder (target from package.json: nsis)'
}

Push-Location $electronApp
try {
  npx electron-builder @ebArgs --publish never
  if ($LASTEXITCODE -ne 0) {
    throw "electron-builder failed (exit $LASTEXITCODE)"
  }
} finally {
  Pop-Location
}

$distDir = Join-Path $electronApp 'dist'
if (-not (Test-Path $distDir)) {
  throw "electron-builder reported success but $distDir is missing."
}

# The -Target dir output goes one level deeper (e.g. dist\win-unpacked\*.exe).
# Installer artifacts land directly in dist\. Find whichever layout matches.
$installerRoot = $distDir
if ($Target -eq 'dir') {
  # Windows unpacked layout is dist\win-unpacked\ — any platform-specific
  # *-unpacked subdir works for our purposes.
  $unpacked = Get-ChildItem $distDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*-unpacked' } | Select-Object -First 1
  if ($unpacked) { $installerRoot = $unpacked.FullName }
}

$artifacts = Get-ChildItem $installerRoot -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '\.exe$' } |
  Sort-Object LastWriteTime -Descending

Write-Host ''
Write-Host 'Build complete.' -ForegroundColor Cyan
Write-Host "  Output: $installerRoot" -ForegroundColor Cyan
if ($artifacts) {
  foreach ($a in $artifacts) {
    $size = "{0:N2} MB" -f ($a.Length / 1MB)
    Write-Host "  $($a.FullName)  ($size)" -ForegroundColor Green
  }
}
Write-Host ''
if ($Target -eq 'dir') {
  Write-Host 'To launch the unpacked build:' -ForegroundColor Cyan
  Write-Host "  & `"$($artifacts[0].FullName)`"" -ForegroundColor Cyan
} elseif ($artifacts) {
  $installer = $artifacts | Where-Object { $_.Name -like '*setup.exe' } | Select-Object -First 1
  if ($installer) {
    Write-Host 'To install locally, open:' -ForegroundColor Cyan
    Write-Host "  $($installer.FullName)" -ForegroundColor Cyan
  }
}
