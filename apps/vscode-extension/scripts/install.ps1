<#
.SYNOPSIS
  Install the (already-built) Praxis VS Code extension into all
  detected VS Code-family editors: VS Code, VS Code Insiders, and Cursor.

.DESCRIPTION
  Installs the built .vsix into each detected editor using that editor's CLI
  (`code`/`code-insiders`/`cursor --install-extension`). If an editor's CLI
  isn't on PATH, falls back to copying the compiled payload (package.json,
  out/, media/) straight into the editor's extensions folder.

  Unlike Frosty, Praxis does NOT need proposed APIs in argv.json
  (activation is `onStartupFinished`).

  This script does NOT build. Run build.ps1 first (or use `npm run build:install`).
  If no .vsix and no out/ are found, it errors out.

.PARAMETER Uninstall
  Remove the Praxis extension from all detected editors.

.EXAMPLE
  pwsh ./scripts/build.ps1
  pwsh ./scripts/install.ps1

.EXAMPLE
  .\build.ps1 && .\install.ps1

.EXAMPLE
  pwsh ./scripts/install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# --- Locate the extension root -----------------------------------------------
# install.ps1 lives in <extensionRoot>/scripts, so the root is one level up.
$scriptDir = $PSScriptRoot
$extensionRoot = Split-Path -Parent $scriptDir
if (-not (Test-Path (Join-Path $extensionRoot 'package.json'))) {
  throw "Could not locate the extension root (no package.json at $extensionRoot)."
}

$pkg = Get-Content (Join-Path $extensionRoot 'package.json') -Raw | ConvertFrom-Json
$extId = "$($pkg.publisher).$($pkg.name)"
$folderName = "$extId-$($pkg.version)"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  + $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }

# --- Detect editors ----------------------------------------------------------
$editors = @(
  [pscustomobject]@{ Name = 'VS Code';          Ext = (Join-Path $HOME ".vscode/extensions");          Cli = 'code' }
  [pscustomobject]@{ Name = 'VS Code Insiders';  Ext = (Join-Path $HOME ".vscode-insiders/extensions");  Cli = 'code-insiders' }
  [pscustomobject]@{ Name = 'Cursor';            Ext = (Join-Path $HOME ".cursor/extensions");           Cli = 'cursor' }
)

$detected = $editors | Where-Object { Test-Path $_.Ext }
if (-not $detected) {
  Write-Warn2 'No VS Code-family editors detected (.vscode, .vscode-insiders, .cursor).'
  exit 1
}

# --- Uninstall path ----------------------------------------------------------
if ($Uninstall) {
  Write-Step "Uninstalling $extId from all editors"
  foreach ($e in $detected) {
    $removed = 0
    $cli = Get-Command $e.Cli -ErrorAction SilentlyContinue
    if ($cli) {
      $null = & { $ErrorActionPreference = 'Continue'; & $cli.Source --uninstall-extension $extId 2>&1 }
      if ($LASTEXITCODE -eq 0) { $removed++ }
    }
    Get-ChildItem $e.Ext -Directory -Filter "$extId-*" -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item -Recurse -Force $_.FullName
      $removed++
    }
    if ($removed -gt 0) { Write-Ok "$($e.Name): removed" }
    else { Write-Warn2 "$($e.Name): nothing to remove" }
  }
  Write-Host 'Done. Restart your editors to apply.' -ForegroundColor Cyan
  exit 0
}

# --- Locate the build output -------------------------------------------------
# Prefer the packaged .vsix (installed via each editor's CLI). Fall back to the
# compiled payload (folder-copy) when no .vsix exists or an editor CLI is absent.
$outDir = Join-Path $extensionRoot 'out'
$haveOut = Test-Path (Join-Path $outDir 'extension.js')

$vsixPath = $null
$artifactsRoot = Join-Path $extensionRoot 'artifacts'
if (Test-Path $artifactsRoot) {
  $vsixPath = Get-ChildItem $artifactsRoot -Filter "$($pkg.name)-*.vsix" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}

if (-not $vsixPath -and -not $haveOut) {
  throw "No .vsix in $artifactsRoot and no build at $outDir. Run scripts/build.ps1 first (or use 'npm run build:install')."
}

# Files/folders that make up the installable extension payload (folder-copy fallback).
$payload = @('package.json', 'README.md', 'EXTENSION.md', 'out', 'media') |
  Where-Object { Test-Path (Join-Path $extensionRoot $_) }

# --- Install helpers ---------------------------------------------------------
function Resolve-EditorCli($cli) {
  $cmd = Get-Command $cli -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# Install via the editor's CLI: `code --install-extension <vsix>`. Returns
# $true on success, $false if the CLI isn't available or the call fails.
$script:LastVsixError = $null
function Install-FromVsix($cliPath, $vsix) {
  $script:LastVsixError = $null
  if (-not $cliPath) { return $false }
  # `--allow-star-activation` skips the "Using '*' activation…" confirmation
  # on VS Code 1.83+. The "y`n" piped to stdin is a defensive fallback for
  # older editors (where the flag is unknown) or wraps that strip the flag
  # — VS Code's prompt reads one line from stdin and accepts 'y' as consent.
  # The editor CLI (code.cmd) can emit Node deprecation warnings to stderr.
  # With $ErrorActionPreference='Stop', redirecting stderr (2>&1) would turn
  # those warnings into terminating errors, so relax it for just this call and
  # rely on $LASTEXITCODE to determine real success/failure.
  $yesInput = 'y' + [Environment]::NewLine
  $out = & {
    $ErrorActionPreference = 'Continue'
    $yesInput | & $cliPath --install-extension $vsix --force --allow-star-activation 2>&1
  }
  if ($LASTEXITCODE -eq 0) { return $true }
  $script:LastVsixError = ($out | Out-String).Trim()
  return $false
}

# Folder-copy fallback: drop the payload straight into the extensions dir.
function Install-FromPayload($extDir) {
  $dest = Join-Path $extDir $folderName
  Get-ChildItem $extDir -Directory -Filter "$extId-*" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -Recurse -Force $_.FullName
  }
  New-Item -ItemType Directory -Force $dest | Out-Null
  foreach ($item in $payload) {
    Copy-Item -Recurse -Force (Join-Path $extensionRoot $item) $dest
  }
}

# --- Install into each editor ------------------------------------------------
Write-Step "Installing $folderName"
if ($vsixPath) { Write-Ok "Using .vsix: $vsixPath" }
else { Write-Warn2 "No .vsix found; using folder-copy install from $outDir" }

foreach ($e in $detected) {
  $method = $null
  $cliPath = if ($vsixPath) { Resolve-EditorCli $e.Cli } else { $null }

  if ($vsixPath -and (Install-FromVsix $cliPath $vsixPath)) {
    $method = "vsix via '$($e.Cli)'"
  } elseif ($haveOut) {
    if ($vsixPath -and -not $cliPath) {
      Write-Warn2 "$($e.Name): '$($e.Cli)' CLI not on PATH; using folder-copy"
    } elseif ($vsixPath -and $script:LastVsixError -match 'restart') {
      Write-Warn2 "$($e.Name): editor is running (CLI wants a restart); using folder-copy instead"
    } elseif ($vsixPath) {
      Write-Warn2 "$($e.Name): CLI install failed; using folder-copy. Details: $script:LastVsixError"
    }
    Install-FromPayload $e.Ext
    $method = 'folder-copy'
  } else {
    Write-Warn2 "$($e.Name): no install method available (no working CLI and no out/)."
    continue
  }

  Write-Ok "$($e.Name): installed ($method)"
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Cyan
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Fully restart each editor (close all windows).'
Write-Host '  2. Open the Praxis activity-bar entry and pick a backend.'
Write-Host '  3. Configure Connections & Boards (and AI Gateway Settings if using AI).'
