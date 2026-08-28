<#
.SYNOPSIS
  Download Praxis from the GitLab Package Registry and install it.

.DESCRIPTION
  Fetches praxis-<version>.vsix (and the bundled install.ps1) from
  this project's Generic Package Registry, then installs into detected
  editors (VS Code / Insiders / Cursor).

  Auth (first match wins): -Token, GITLAB_TOKEN / GITLAB_PRIVATE_TOKEN /
  CI_JOB_TOKEN, or `glab config get token`.

  Does not require a git clone — only PowerShell + network access to GitLab.

.PARAMETER Version
  Package version to install (e.g. 0.1.0). Default: newest semver in the registry.

.PARAMETER Uninstall
  Passed through to the installer (remove Praxis from editors).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-from-gitlab.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install-from-gitlab.ps1 -Version 0.1.0
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$ProjectId,
  [string]$ApiUrl,
  [string]$Token,
  [string]$PackageName = 'praxis',
  [string]$GitLabHost = 'git.example.com',
  [string]$ProjectPath = 'example/software/ai/tools/praxis',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "  + $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }

function Resolve-GitLabToken {
  param([string]$Explicit, [string]$HostName)
  if ($Explicit) { return ("$Explicit").Trim() }
  foreach ($key in @('GITLAB_TOKEN', 'GITLAB_PRIVATE_TOKEN', 'CI_JOB_TOKEN')) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($value -and "$value".Trim()) { return ("$value").Trim() }
  }
  if (Get-Command glab -ErrorAction SilentlyContinue) {
    $fromConfig = & glab config get token --host $HostName 2>$null | Out-String
    if ($fromConfig -and "$fromConfig".Trim() -and "$fromConfig" -notmatch 'USAGE') {
      return ("$fromConfig").Trim()
    }
  }
  return $null
}

function Get-AuthHeaders([string]$Tok) {
  if ($env:CI_JOB_TOKEN -and ($Tok -eq $env:CI_JOB_TOKEN)) {
    return @{ 'JOB-TOKEN' = $Tok }
  }
  return @{ 'PRIVATE-TOKEN' = $Tok }
}

function Invoke-GitLabDownload {
  param(
    [string]$Uri,
    [hashtable]$Headers,
    [string]$OutFile
  )
  try {
    Invoke-WebRequest -Uri $Uri -Headers $Headers -OutFile $OutFile -UseBasicParsing
  } catch {
    $status = $null
    $body = $null
    try {
      $resp = $_.Exception.Response
      if ($resp) {
        $status = [int]$resp.StatusCode
        $stream = $resp.GetResponseStream()
        if ($stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          $body = $reader.ReadToEnd()
          $reader.Dispose()
        }
      }
    } catch {}
    $hint = if ($status -eq 401 -or $status -eq 403) {
      'Check glab auth / GITLAB_TOKEN (needs read_api or api).'
    } elseif ($status -eq 404) {
      'Package file not found — check version or republish.'
    } else {
      $_.Exception.Message
    }
    throw "Download failed ($status) $Uri`n$hint`n$body"
  }
}

$Token = Resolve-GitLabToken -Explicit $Token -HostName $GitLabHost
if (-not $Token) {
  throw @"
No GitLab token found. Run once:
  glab auth login --hostname $GitLabHost
Or set `$env:GITLAB_TOKEN to a personal/project access token with read_api (or api) scope.
"@
}

if (-not $ApiUrl) { $ApiUrl = "https://$GitLabHost/api/v4" }
if (-not $ProjectId) { $ProjectId = [uri]::EscapeDataString($ProjectPath) }

$headers = Get-AuthHeaders $Token
$packagesUrl = "$ApiUrl/projects/$ProjectId/packages?package_type=generic&package_name=$PackageName&order_by=created_at&sort=desc&per_page=50"

if (-not $Version) {
  Write-Step 'Resolving latest package version'
  try {
    $packages = Invoke-RestMethod -Uri $packagesUrl -Headers $headers
  } catch {
    throw "Could not list packages at $packagesUrl`n$($_.Exception.Message)`nIf this is 401/403, run: glab auth login --hostname $GitLabHost"
  }
  if (-not $packages -or @($packages).Count -eq 0) {
    throw "No generic packages named '$PackageName' found in the registry."
  }
  $semver = @($packages | Where-Object { $_.version -match '^\d+\.\d+\.\d+' })
  if ($semver.Count -eq 0) {
    throw "No semver package versions found for '$PackageName'."
  }
  $Version = $semver[0].version
  Write-Ok "Using $Version"
}

$base = "$ApiUrl/projects/$ProjectId/packages/generic/$PackageName/$Version"
$vsixName = "$PackageName-$Version.vsix"
$workDir = Join-Path $env:TEMP ("praxis-install-" + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Force $workDir | Out-Null

try {
  Write-Step "Downloading $vsixName"
  $vsixPath = Join-Path $workDir $vsixName
  Invoke-GitLabDownload -Uri "$base/$vsixName" -Headers $headers -OutFile $vsixPath
  Write-Ok $vsixPath

  $installerPath = Join-Path $workDir 'install.ps1'
  $downloadedInstaller = $false
  try {
    Invoke-GitLabDownload -Uri "$base/install.ps1" -Headers $headers -OutFile $installerPath
    $downloadedInstaller = $true
  } catch {
    Write-Host "  ! Registry install.ps1 unavailable; trying local fallback" -ForegroundColor Yellow
  }
  if (-not $downloadedInstaller) {
    $repoInstaller = $null
    if ($PSScriptRoot) {
      $repoInstaller = Join-Path $PSScriptRoot 'install-dist.ps1'
    }
    if ($repoInstaller -and (Test-Path -LiteralPath $repoInstaller)) {
      Copy-Item $repoInstaller $installerPath
    } else {
      throw "Could not download install.ps1 for $PackageName@$Version, and no local install-dist.ps1 was found."
    }
  }

  Write-Step 'Installing'
  if ($Uninstall) {
    & $installerPath -VsixPath $vsixPath -Uninstall
  } else {
    & $installerPath -VsixPath $vsixPath
  }
}
finally {
  if (Test-Path -LiteralPath $workDir) {
    Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
  }
}
