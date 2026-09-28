<# Build a locally signed Windows installer without writing credentials to disk. #>
[CmdletBinding()]
param(
  [string]$Certificate,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Read-Required([string]$Prompt) {
  $value = Read-Host $Prompt
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Prompt is required" }
  return $value
}

function Read-SecretText([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrEmpty($value)) { throw "$Prompt is required" }
    return $value
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

if ([string]::IsNullOrWhiteSpace($env:WIN_CSC_LINK)) {
  if ([string]::IsNullOrWhiteSpace($Certificate)) {
    $Certificate = Read-Required 'Authenticode .pfx path'
  }
  $resolved = Resolve-Path $Certificate -ErrorAction Stop
  $env:WIN_CSC_LINK = $resolved.Path
}

if ([string]::IsNullOrWhiteSpace($env:WIN_CSC_KEY_PASSWORD)) {
  $env:WIN_CSC_KEY_PASSWORD = Read-SecretText '.pfx password'
}

try {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build-installer.ps1'), '-Target', 'nsis')
  if ($SkipBuild) { $arguments += '-SkipBuild' }
  & powershell @arguments
  if ($LASTEXITCODE -ne 0) { throw "Signed Windows packaging failed (exit $LASTEXITCODE)" }
} finally {
  Remove-Item Env:WIN_CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
}
