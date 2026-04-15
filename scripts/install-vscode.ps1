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
$extensionId = "$($packageJson.publisher).$($packageJson.name)"
$quotedVsixPath = '"' + $vsixPath + '"'

$codeCli = Get-Command code -ErrorAction SilentlyContinue
if (-not $codeCli) {
    throw 'VS Code CLI (code) was not found on PATH. Open VS Code and run "Shell Command: Install code command in PATH".'
}

$quotedCodeCliPath = '"' + $codeCli.Source + '"'

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

Write-Host "Removing existing $extensionId from VS Code"
& cmd.exe /d /c "$quotedCodeCliPath --uninstall-extension $extensionId >nul 2>nul"

Write-Host "Installing $vsixPath into VS Code"
& cmd.exe /d /c "$quotedCodeCliPath --install-extension $quotedVsixPath --force"

if ($LASTEXITCODE -ne 0) {
    throw "VS Code failed to install $vsixPath (exit code $LASTEXITCODE)."
}
