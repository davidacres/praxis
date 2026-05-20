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
$artifactsPath = Join-Path $projectRoot 'artifacts'
$vsixPath = Join-Path $artifactsPath "$($packageJson.name)-$($packageJson.version).vsix"
$extensionId = "$($packageJson.publisher).$($packageJson.name)"
$quotedVsixPath = '"' + $vsixPath + '"'

function Get-StableVsCodeCliPath {
    $candidatePaths = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code'),
        (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code.cmd'),
        (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code\bin\code.cmd'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code\bin\code')
    )

    foreach ($candidate in $candidatePaths) {
        if ($candidate -and (Test-Path $candidate)) {
            return $candidate
        }
    }

    $codeCommand = Get-Command code -ErrorAction SilentlyContinue
    if ($codeCommand -and $codeCommand.Source -match 'Microsoft VS Code') {
        return $codeCommand.Source
    }

    throw 'Stable VS Code CLI was not found. Install VS Code or add the stable VS Code shell command to PATH.'
}

$codeCliPath = Get-StableVsCodeCliPath
$quotedCodeCliPath = '"' + $codeCliPath + '"'

if (-not $SkipPackage) {
    if (-not (Test-Path $artifactsPath)) {
        New-Item -ItemType Directory -Path $artifactsPath | Out-Null
    }
    Push-Location $projectRoot
    try {
        $repoUrl = "https://git.tools.dev.assaabloyglobalsolutions.net/traka/software/ai/tools/ticket-manager-extension"
        $rawContentUrl = "$repoUrl/-/raw/main/"
        & npx @vscode/vsce package --baseContentUrl $rawContentUrl --baseImagesUrl $rawContentUrl --out $vsixPath
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
