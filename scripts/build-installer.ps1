# Package the already-built Praxis desktop app with electron-builder.
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [ValidateSet('nsis', 'portable', 'dir')]
  [string]$Target = 'nsis'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$electronApp = Join-Path $repoRoot 'apps/praxis-desktop/main'

function Invoke-Npm($workingDir, $scriptName) {
  Push-Location $workingDir
  try {
    npm run $scriptName
    if ($LASTEXITCODE -ne 0) { throw "npm run $scriptName failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }
}

$env:NODE_OPTIONS = ''
if (-not $SkipBuild) {
  & (Join-Path $PSScriptRoot 'build-app.ps1')
  if ($LASTEXITCODE -ne 0) { throw "build-app.ps1 failed (exit $LASTEXITCODE)" }
} else {
  foreach ($path in @(
    (Join-Path $repoRoot 'packages/core/out/index.js'),
    (Join-Path $repoRoot 'apps/praxis-desktop/renderer/dist/index.html'),
    (Join-Path $electronApp 'out/main/index.js'),
    (Join-Path $electronApp 'renderer/index.html')
  )) {
    if (-not (Test-Path $path)) { throw "Missing build input: $path" }
  }
}

$ebArgs = if ($Target -eq 'dir') { @('--dir') } else { @('--win', $Target) }
Write-Host "==> Packaging Praxis ($Target)" -ForegroundColor Cyan
Push-Location $electronApp
try {
  npx electron-builder @ebArgs --publish never
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

Write-Host '  + Installer artifacts are ready:' -ForegroundColor Green
Get-ChildItem (Join-Path $electronApp 'dist') -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in @('.exe', '.msi', '.AppImage') } |
  ForEach-Object { Write-Host "    $($_.FullName)" }
