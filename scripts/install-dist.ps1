<#
.SYNOPSIS
  Standalone installer for the Ticket Manager VS Code extension. Distribute
  this file alongside the .vsix; it has no other dependencies.

.DESCRIPTION
  Installs the Ticket Manager .vsix that sits next to this script into every
  detected VS Code-family editor (VS Code, VS Code Insiders, Cursor) using
  that editor's CLI (`code` / `code-insiders` / `cursor --install-extension`).

  The extension id and version are read directly from the .vsix, so this
  script needs no source checkout and no package.json — just the .vsix
  beside it.

  Unlike the Frosty installer, Ticket Manager does NOT register a proposed
  API: the activationEvents set is `onStartupFinished`, which works without
  any `enable-proposed-api` flag in argv.json.

.PARAMETER VsixPath
  Path to the .vsix to install. Defaults to the newest ticket-manager-*.vsix
  found in the same folder as this script.

.PARAMETER Uninstall
  Remove the Ticket Manager extension from all detected editors.

.EXAMPLE
  # From the folder containing install-dist.ps1 and the .vsix:
  pwsh ./install-dist.ps1

.EXAMPLE
  pwsh ./install-dist.ps1 -VsixPath .\ticket-manager-0.1.0.vsix

.EXAMPLE
  pwsh ./install-dist.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$VsixPath,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  + $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }

# --- Locate the .vsix ------------------------------------------------------
if (-not $VsixPath) {
  $VsixPath = Get-ChildItem $scriptDir -Filter 'ticket-manager-*.vsix' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $VsixPath) {
  $VsixPath = Get-ChildItem $scriptDir -Filter '*.vsix' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $VsixPath -or -not (Test-Path $VsixPath)) {
  throw "No .vsix found. Place this script next to the Ticket Manager .vsix, or pass -VsixPath <file>."
}
$VsixPath = (Resolve-Path $VsixPath).Path

# --- Read extension id + version from the .vsix ----------------------------
# A .vsix is a zip; extension/package.json holds publisher, name and version.
function Get-VsixManifest($vsix) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($vsix)
  try {
    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'extension/package.json' } | Select-Object -First 1
    if (-not $entry) { throw "extension/package.json not found inside $vsix (is it a valid VSIX?)." }
    $reader = New-Object System.IO.StreamReader($entry.Open())
    try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }
  } finally {
    $zip.Dispose()
  }
  return $json | ConvertFrom-Json
}

$pkg = Get-VsixManifest $VsixPath
if (-not $pkg.publisher -or -not $pkg.name) {
  throw "Could not read publisher/name from the .vsix manifest."
}
$extId = "$($pkg.publisher).$($pkg.name)"

# --- Detect editors --------------------------------------------------------
$editors = @(
  [pscustomobject]@{ Name = 'VS Code';          Ext = "$env:USERPROFILE\.vscode\extensions";          Cli = 'code' }
  [pscustomobject]@{ Name = 'VS Code Insiders'; Ext = "$env:USERPROFILE\.vscode-insiders\extensions"; Cli = 'code-insiders' }
  [pscustomobject]@{ Name = 'Cursor';           Ext = "$env:USERPROFILE\.cursor\extensions";          Cli = 'cursor' }
)

$detected = $editors | Where-Object { Test-Path $_.Ext }
if (-not $detected) {
  Write-Warn2 'No VS Code-family editors detected (.vscode, .vscode-insiders, .cursor).'
  exit 1
}

# --- Uninstall path --------------------------------------------------------
if ($Uninstall) {
  Write-Step "Uninstalling $extId from all editors"
  foreach ($e in $detected) {
    $removed = 0
    $cli = Get-Command $e.Cli -ErrorAction SilentlyContinue
    if ($cli) {
      $out = & { $ErrorActionPreference = 'Continue'; & $cli.Source --uninstall-extension $extId 2>&1 }
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

# --- Install helpers -------------------------------------------------------
function Resolve-EditorCli($cli) {
  $cmd = Get-Command $cli -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$script:LastVsixError = $null
function Install-FromVsix($cliPath, $vsix) {
  $script:LastVsixError = $null
  if (-not $cliPath) { return $false }
  # `--allow-star-activation` skips the "Using '*' activation…" confirmation on
  # VS Code 1.83+. The `y` piped to stdin is a defensive fallback for older
  # editors where the flag is unknown — VS Code's prompt reads one line from
  # stdin and accepts 'y' as consent.
  $yesInput = 'y' + [Environment]::NewLine
  $out = & {
    $ErrorActionPreference = 'Continue'
    $yesInput | & $cliPath --install-extension $vsix --force --allow-star-activation 2>&1
  }
  if ($LASTEXITCODE -eq 0) { return $true }
  $script:LastVsixError = ($out | Out-String).Trim()
  return $false
}

# --- Install into each editor ----------------------------------------------
Write-Step "Installing $extId v$($pkg.version)"
Write-Ok "Using .vsix: $VsixPath"

$anyFailed = $false
foreach ($e in $detected) {
  $cliPath = Resolve-EditorCli $e.Cli

  if ($cliPath -and (Install-FromVsix $cliPath $VsixPath)) {
    $method = "vsix via '$($e.Cli)'"
  } elseif (-not $cliPath) {
    Write-Warn2 "$($e.Name): '$($e.Cli)' CLI not on PATH. Install the .vsix manually (Extensions view -> '...' -> Install from VSIX)."
    $anyFailed = $true
    continue
  } else {
    Write-Warn2 "$($e.Name): CLI install failed. Details: $script:LastVsixError"
    $anyFailed = $true
    continue
  }

  Write-Ok "$($e.Name): installed ($method)"
}

Write-Host ''
if ($anyFailed) { Write-Warn2 'Completed with warnings (see above).' }
Write-Host 'Done.' -ForegroundColor Cyan
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Fully restart each editor (close all windows).'
Write-Host '  2. Click the Ticket Manager activity-bar entry and pick a backend.'
Write-Host '  3. Configure Connections & Boards.'
