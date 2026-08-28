#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot Praxis install from GitLab Package Registry (no repo clone).

.DESCRIPTION
  Downloads install-from-gitlab.ps1 from the floating "latest" package pointer,
  then runs it. Auth via glab or GITLAB_TOKEN.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap-praxis.ps1
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$Token,
  [string]$GitLabHost = 'git.example.com',
  [string]$ProjectPath = 'example/software/ai/tools/praxis'
)

$ErrorActionPreference = 'Stop'

function Resolve-Token([string]$Explicit, [string]$HostName) {
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

$tok = Resolve-Token -Explicit $Token -HostName $GitLabHost
if (-not $tok) {
  throw @"
No GitLab token. Run once:
  glab auth login --hostname $GitLabHost
Or: `$env:GITLAB_TOKEN = '<PAT with read_api>'
"@
}

$projectId = [uri]::EscapeDataString($ProjectPath)
$uri = "https://$GitLabHost/api/v4/projects/$projectId/packages/generic/praxis/latest/install-from-gitlab.ps1"
$scriptPath = Join-Path $env:TEMP 'praxis-install-from-gitlab.ps1'

Write-Host "==> Fetching installer from Package Registry" -ForegroundColor Cyan
Invoke-WebRequest -Uri $uri -Headers @{ 'PRIVATE-TOKEN' = $tok } -OutFile $scriptPath -UseBasicParsing
Write-Host "  + $scriptPath" -ForegroundColor Green

$args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath, '-Token', $tok)
if ($Version) { $args += @('-Version', $Version) }

# Prefer Windows PowerShell so this works without pwsh installed.
& powershell @args
exit $LASTEXITCODE
