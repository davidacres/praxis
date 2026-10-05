<#
.SYNOPSIS
  Installs or updates the Praxis desktop app on Windows.

.DESCRIPTION
  Downloads and executes the latest Praxis Windows installer (.exe) from GitHub Releases.

.EXAMPLE
  irm https://raw.githubusercontent.com/davidacres/praxis/main/scripts/install.ps1 | iex

.EXAMPLE
  powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/davidacres/praxis/main/scripts/install.ps1 | iex"
#>

[CmdletBinding()]
param(
  [string]$Version,
  [switch]$Silent,
  [switch]$Launch,
  [switch]$Help
)

if ($Help) {
  Write-Host @"
Praxis Windows Installer

Usage:
  irm https://raw.githubusercontent.com/davidacres/praxis/main/scripts/install.ps1 | iex

Options (when passing arguments):
  -Version <string>   Install a specific version (e.g. 0.4.1 or v0.4.1)
  -Silent             Run installer silently without wizard prompts
  -Launch             Automatically start Praxis after installation
  -Help               Show this help message
"@
  exit 0
}

$ErrorActionPreference = 'Stop'
$repo = 'davidacres/praxis'

# Ensure modern TLS
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

# Resolve version
if (-not $Version) {
  Write-Host "==> Finding latest release of Praxis..." -ForegroundColor Cyan
  try {
    # Check redirect URL of latest release to avoid API rate limits
    $req = [System.Net.HttpWebRequest]::Create("https://github.com/$repo/releases/latest")
    $req.AllowAutoRedirect = $false
    $resp = $req.GetResponse()
    $location = $resp.GetResponseHeader("Location")
    $resp.Close()
    if ($location -match 'tag/(v?[\d\.]+)') {
      $Version = $Matches[1]
    }
  } catch {
    # Fallback to GitHub REST API
    try {
      $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "Praxis-Installer" }
      $Version = $release.tag_name
    } catch {
      Write-Error "Could not resolve latest release. Please specify -Version <version>."
      exit 1
    }
  }
}

if (-not $Version) {
  Write-Error "Could not determine version to install."
  exit 1
}

$tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
$versionNum = $tag.TrimStart("v")
Write-Host "  ✓ Selected version: $tag" -ForegroundColor Green

$assetName = "Praxis-$versionNum-setup.exe"
$tempDir = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$tempPath = Join-Path $tempDir $assetName

Write-Host "==> Downloading Praxis $tag for Windows..." -ForegroundColor Cyan
Write-Host "    $downloadUrl" -ForegroundColor Gray

try {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $tempPath -UseBasicParsing
  Write-Host "  ✓ Download complete" -ForegroundColor Green
} catch {
  Write-Error "Failed to download $assetName from $($downloadUrl): $_"
  exit 1
}

Write-Host "==> Running Praxis installer..." -ForegroundColor Cyan
$installerArgs = @()
if ($Silent) {
  $installerArgs += "/S"
}

try {
  $process = Start-Process -FilePath $tempPath -ArgumentList $installerArgs -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Write-Warning "Installer exited with code $($process.ExitCode)."
  } else {
    Write-Host "`n  ✓ Praxis $tag installed successfully!" -ForegroundColor Green
  }
} finally {
  Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
}

if ($Launch) {
  $installedApp = Join-Path $env:LOCALAPPDATA "Programs\Praxis\Praxis.exe"
  if (Test-Path $installedApp) {
    Write-Host "==> Launching Praxis..." -ForegroundColor Cyan
    Start-Process -FilePath $installedApp
  } else {
    Start-Process -FilePath "Praxis" -ErrorAction SilentlyContinue
  }
}
