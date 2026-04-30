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

$insidersCli = Get-Command code-insiders -ErrorAction SilentlyContinue
if (-not $insidersCli) {
    throw 'VS Code Insiders CLI (code-insiders) was not found on PATH. Open VS Code Insiders and run "Shell Command: Install code-insiders command in PATH".'
}

if (-not $SkipPackage) {
    Push-Location $projectRoot
    try {
        $repoUrl = "https://git.example.com/example/software/ai/tools/ticket-manager-extension"
        $rawContentUrl = "$repoUrl/-/raw/main/"
        & npx @vscode/vsce package --baseContentUrl $rawContentUrl --baseImagesUrl $rawContentUrl
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path $vsixPath)) {
    throw "VSIX not found at $vsixPath"
}

Write-Host "Installing $vsixPath into VS Code Insiders"
& code-insiders --install-extension $vsixPath
