<#
.SYNOPSIS
  Build the Praxis Electron desktop app without packaging an installer.

.DESCRIPTION
  Orchestrates the full pipeline:

    1. packages/core          -> tsc, produces out/ with the runtime library
    2. apps/praxis-desktop/renderer      -> vite build, produces dist/ that the renderer loads
    3. apps/praxis-desktop/main  -> tsc, produces out/main + out/preload
    4. copy-renderer step     -> apps/praxis-desktop/renderer/dist -> apps/praxis-desktop/main/renderer
                                 (so `loadFile('../../renderer/index.html')` resolves
                                 inside the asar — see apps/praxis-desktop/main/src/main/index.ts)
  Installer packaging is handled separately by build-installer.ps1.

.PARAMETER SkipBuild
  Skip the workspace compile/copy steps and verify the already-built artifacts.
  Fails fast if any required input is missing.

.EXAMPLE
  npm run app:build

.EXAMPLE
  pwsh ./scripts/build-app.ps1

.EXAMPLE
  pwsh ./scripts/build-app.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$core = Join-Path $repoRoot 'packages/core'
$frontend = Join-Path $repoRoot 'apps/praxis-desktop/renderer'
$electronApp = Join-Path $repoRoot 'apps/praxis-desktop/main'

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

  Write-Step 'Building apps/praxis-desktop/renderer'
  Invoke-Npm $frontend 'build'
  Write-Ok 'frontend -> dist/'

  Write-Step 'Compiling apps/praxis-desktop/main'
  Invoke-Npm $electronApp 'compile'
  Write-Ok 'electron-app -> out/'

  Write-Step 'Copying frontend/dist into electron-app/renderer'
  Invoke-Npm $electronApp 'copy-renderer'
  Write-Ok 'renderer ready for asar packaging'
}

Write-Host ''
Write-Host 'Praxis app build is ready.' -ForegroundColor Cyan
Write-Host "  Renderer: $(Join-Path $frontend 'dist')" -ForegroundColor Green
Write-Host "  Desktop:  $(Join-Path $electronApp 'out')" -ForegroundColor Green
