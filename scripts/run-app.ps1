<#
.SYNOPSIS
  Build and launch the Ticket Manager desktop (Electron) app.

.DESCRIPTION
  Compiles the three workspaces in dependency order and starts Electron:

    1. packages/core          -> tsc, produces out/ that the main process imports
    2. packages/frontend      -> vite build, produces dist/ that the window loads
    3. packages/electron-app  -> tsc, produces out/main + out/preload
    4. electron .             -> opens the frameless window

  In -Dev mode step 2 is replaced by the Vite dev server: the script starts it,
  waits for the port to answer, and points the main process at it through
  TICKET_MANAGER_DEV_SERVER_URL so the renderer hot-reloads on save. The server
  is shut down again when the app window closes.

  NODE_OPTIONS is cleared for the child processes. Electron rejects flags such
  as --use-system-ca when they arrive via NODE_OPTIONS and exits with code 9
  before the window ever appears, which is easy to mistake for a build failure.

.PARAMETER Dev
  Run against the Vite dev server (hot reload) instead of the built assets.

.PARAMETER SkipBuild
  Launch whatever is already compiled. Fails fast if a build output is missing.

.PARAMETER Port
  Port for the Vite dev server in -Dev mode. Default 5173.

.EXAMPLE
  npm run app

.EXAMPLE
  pwsh ./scripts/run-app.ps1 -Dev

.EXAMPLE
  pwsh ./scripts/run-app.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
  [switch]$Dev,
  [switch]$SkipBuild,
  [int]$Port = 5173
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$core = Join-Path $repoRoot 'packages/core'
$frontend = Join-Path $repoRoot 'packages/frontend'
$electronApp = Join-Path $repoRoot 'packages/electron-app'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  + $msg" -ForegroundColor Green }

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
    throw "Missing $path — run without -SkipBuild ($hint)."
  }
}

if ($SkipBuild) {
  Write-Step 'Skipping build; checking existing output'
  Assert-Built (Join-Path $core 'out/index.js') 'core is not compiled'
  Assert-Built (Join-Path $electronApp 'out/main/index.js') 'electron-app is not compiled'
  if (-not $Dev) {
    Assert-Built (Join-Path $frontend 'dist/index.html') 'frontend is not built'

    # Refreshing renderer/ from frontend/dist is cheap — always run it so the
    # -SkipBuild path still tracks any manual frontend rebuilds. Without this,
    # win.loadFile('../../renderer/index.html') has nothing to load and the
    # app window opens blank.
    Write-Step 'Refreshing renderer/ from frontend/dist'
    Invoke-Npm $electronApp 'copy-renderer'
  }
  Write-Ok 'Existing build output looks complete'
} else {
  Write-Step 'Compiling packages/core'
  Invoke-Npm $core 'compile'
  Write-Ok 'core -> out/'

  if (-not $Dev) {
    Write-Step 'Building packages/frontend'
    Invoke-Npm $frontend 'build'
    Write-Ok 'frontend -> dist/'
  }

  Write-Step 'Compiling packages/electron-app'
  Invoke-Npm $electronApp 'compile'
  Write-Ok 'electron-app -> out/'

  if (-not $Dev) {
    # win.loadFile('../../renderer/index.html') reads from packages/electron-app/renderer,
    # not packages/frontend/dist directly — copy it across or the window opens blank.
    Write-Step 'Copying frontend/dist into electron-app/renderer'
    Invoke-Npm $electronApp 'copy-renderer'
    Write-Ok 'renderer ready'
  }
}

$viteProcess = $null

try {
  if ($Dev) {
    $devUrl = "http://localhost:$Port"
    Write-Step "Starting Vite dev server on $devUrl"
    $viteProcess = Start-Process -FilePath 'npm.cmd' `
      -ArgumentList @('run', 'dev', '--', '--port', "$Port", '--strictPort') `
      -WorkingDirectory $frontend -PassThru -NoNewWindow

    # Poll rather than sleep a fixed amount: a cold Vite start is much slower
    # than a warm one, and guessing wrong shows the user a blank window.
    $ready = $false
    foreach ($attempt in 1..60) {
      Start-Sleep -Milliseconds 500
      try {
        Invoke-WebRequest -Uri $devUrl -UseBasicParsing -TimeoutSec 2 | Out-Null
        $ready = $true
        break
      } catch {
        if ($viteProcess.HasExited) { throw "Vite dev server exited early (code $($viteProcess.ExitCode))." }
      }
    }
    if (-not $ready) { throw "Vite dev server did not answer on $devUrl within 30s." }

    Write-Ok 'Dev server ready'
    $env:TICKET_MANAGER_DEV_SERVER_URL = $devUrl
  } else {
    Remove-Item Env:TICKET_MANAGER_DEV_SERVER_URL -ErrorAction SilentlyContinue
  }

  Write-Step 'Launching Electron'
  Push-Location $electronApp
  try {
    npx electron .
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  if ($exitCode -ne 0) {
    Write-Host "Electron exited with code $exitCode" -ForegroundColor Yellow
    exit $exitCode
  }

  Write-Ok 'App closed'
} finally {
  if ($viteProcess -and -not $viteProcess.HasExited) {
    Write-Step 'Stopping Vite dev server'
    # Only the PID this script started — never a blanket kill by image name.
    Stop-Process -Id $viteProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
