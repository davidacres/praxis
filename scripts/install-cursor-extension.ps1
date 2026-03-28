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

function Get-CursorCliPath {
    $command = Get-Command cursor -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidatePaths = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\cursor\resources\app\bin\cursor.cmd'),
        (Join-Path $env:LOCALAPPDATA 'Programs\cursor\resources\app\bin\cursor.exe')
    )

    foreach ($candidate in $candidatePaths) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    throw 'Cursor CLI was not found. Install the Cursor shell command or add cursor.cmd to PATH.'
}

$cursorCli = Get-CursorCliPath

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

Write-Host "Installing $vsixPath into Cursor using $cursorCli"
& $cursorCli --install-extension $vsixPath
