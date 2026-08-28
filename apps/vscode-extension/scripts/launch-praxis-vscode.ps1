param(
    [string]$OpenPath
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$packageJsonPath = Join-Path $projectRoot 'package.json'

if (-not (Test-Path $packageJsonPath)) {
    throw "package.json not found at $packageJsonPath"
}

$packageJson = Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json
$extensionId = "$($packageJson.publisher).$($packageJson.name)"

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
$workspaceFilePath = Join-Path $env:TEMP 'praxis-shell.code-workspace'
$shellSettings = @{
    'chat.commandCenter.enabled' = $false
    'chat.experimental.detectParticipant.enabled' = $false
    'window.commandCenter' = $false
    'window.menuBarVisibility' = 'toggle'
    'workbench.activityBar.visible' = $false
    'workbench.editor.showTabs' = 'none'
    'workbench.layoutControl.enabled' = $false
    'workbench.secondarySideBar.defaultVisibility' = 'hidden'
    'workbench.startupEditor' = 'none'
    'workbench.statusBar.visible' = $false
}

$installedExtensions = & $codeCliPath --list-extensions
if ($LASTEXITCODE -ne 0) {
    throw "Failed to list installed VS Code extensions (exit code $LASTEXITCODE)."
}
if ($installedExtensions -notcontains $extensionId) {
    throw "Extension '$extensionId' is not installed in your current VS Code profile."
}

if ([string]::IsNullOrWhiteSpace($OpenPath)) {
    $workspaceDefinition = @{
        folders = @()
        settings = $shellSettings
    }
    $workspaceDefinition | ConvertTo-Json -Depth 8 | Set-Content -Path $workspaceFilePath -Encoding UTF8
    Write-Host "Launching VS Code shell workspace with your signed-in profile"
    & $codeCliPath --new-window --disable-extension github.copilot-chat --disable-extension ms-vscode.vscode-chat $workspaceFilePath
}
else {
    $resolvedOpenPath = Resolve-Path -Path $OpenPath -ErrorAction SilentlyContinue
    if (-not $resolvedOpenPath) {
        throw "Open path not found: $OpenPath"
    }
    $launchTarget = $resolvedOpenPath.ProviderPath
    $workspaceDefinition = @{
        folders = @(
            @{
                path = $launchTarget
            }
        )
        settings = $shellSettings
    }
    $workspaceDefinition | ConvertTo-Json -Depth 8 | Set-Content -Path $workspaceFilePath -Encoding UTF8
    Write-Host "Launching VS Code shell workspace at $launchTarget with your signed-in profile"
    & $codeCliPath --new-window --disable-extension github.copilot-chat --disable-extension ms-vscode.vscode-chat $workspaceFilePath
}

if ($LASTEXITCODE -ne 0) {
    throw "VS Code launch failed (exit code $LASTEXITCODE)."
}

# VS Code CLI doesn't reliably support --command across installations.
# Trigger commands via vscode:// protocol after launch.
Start-Sleep -Milliseconds 1200
Start-Process "vscode://command/workbench.action.closeFolder" | Out-Null
Start-Sleep -Milliseconds 300
Start-Process "vscode://command/workbench.action.closeEditors" | Out-Null
Start-Sleep -Milliseconds 300
Start-Process "vscode://command/workbench.action.closePanel" | Out-Null
Start-Sleep -Milliseconds 300
Start-Process "vscode://command/workbench.action.closeAuxiliaryBar" | Out-Null
Start-Sleep -Milliseconds 300
Start-Process "vscode://command/workbench.view.extension.praxis" | Out-Null
Start-Sleep -Milliseconds 400
Start-Process "vscode://command/workbench.action.closePanel" | Out-Null
Start-Sleep -Milliseconds 300
Start-Process "vscode://command/workbench.action.closeAuxiliaryBar" | Out-Null

