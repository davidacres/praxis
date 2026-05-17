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
$quotedVsixPath = '"' + $vsixPath + '"'

function Get-InsidersVsCodeCliPath {
    $candidatePaths = @()
    $baseDirs = @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})
    $relativePaths = @(
        'Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd',
        'Programs\Microsoft VS Code Insiders\bin\code-insiders',
        'Microsoft VS Code Insiders\bin\code-insiders.cmd',
        'Microsoft VS Code Insiders\bin\code-insiders'
    )

    foreach ($baseDir in $baseDirs) {
        if ([string]::IsNullOrWhiteSpace($baseDir)) {
            continue
        }

        foreach ($relativePath in $relativePaths) {
            $candidatePaths += Join-Path $baseDir $relativePath
        }
    }

    foreach ($candidate in $candidatePaths) {
        if ($candidate -and (Test-Path $candidate)) {
            return $candidate
        }
    }

    $insidersCommand = Get-Command code-insiders -ErrorAction SilentlyContinue
    if ($insidersCommand) {
        return $insidersCommand.Source
    }

    throw 'VS Code Insiders CLI was not found. Install VS Code Insiders or add the Insiders shell command to PATH.'
}

$insidersCliPath = Get-InsidersVsCodeCliPath
$quotedInsidersCliPath = '"' + $insidersCliPath + '"'

if (-not $SkipPackage) {
    Push-Location $projectRoot
    try {
        $repoUrl = "https://git.example.com/example/software/ai/tools/ticket-manager-extension"
        $rawContentUrl = "$repoUrl/-/raw/main/"
        & npx @vscode/vsce package --baseContentUrl $rawContentUrl --baseImagesUrl $rawContentUrl
        if ($LASTEXITCODE -ne 0) {
            if (Test-Path $vsixPath) {
                Write-Warning "Packaging failed with exit code $LASTEXITCODE. Continuing with existing VSIX: $vsixPath"
            }
            else {
                throw "Packaging failed with exit code $LASTEXITCODE and no existing VSIX was found at $vsixPath."
            }
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path $vsixPath)) {
    throw "VSIX not found at $vsixPath"
}

Write-Host "Installing $vsixPath into VS Code Insiders"
& cmd.exe /d /c "$quotedInsidersCliPath --install-extension $quotedVsixPath --force"

if ($LASTEXITCODE -ne 0) {
    throw "VS Code Insiders failed to install $vsixPath (exit code $LASTEXITCODE)."
}
