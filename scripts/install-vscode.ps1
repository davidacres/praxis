param(
    [switch]$SkipPackage
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$packageJsonPath = Join-Path $projectRoot 'package.json'

if (-not (Test-Path $packageJsonPath)) {
    throw "package.json not found at $packageJsonPath"
}

$packageJson = Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json
$vsixPath = Join-Path $projectRoot "$($packageJson.name)-$($packageJson.version).vsix"

$codeCli = Get-Command code -ErrorAction SilentlyContinue
if (-not $codeCli) {
    throw 'VS Code CLI (code) was not found on PATH. Open VS Code and run "Shell Command: Install code command in PATH".'
}

if (-not $SkipPackage) {
    Push-Location $projectRoot
    try {
        & npx @vscode/vsce package --allow-missing-repository
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path $vsixPath)) {
    throw "VSIX not found at $vsixPath"
}

Write-Host "Installing $vsixPath into VS Code"
& code --install-extension $vsixPath
