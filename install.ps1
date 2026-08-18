<#
.SYNOPSIS
  Repo-root wrapper for scripts/install.ps1.

.EXAMPLE
  .\build.ps1 && .\install.ps1

.EXAMPLE
  .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
& "$PSScriptRoot\scripts\install.ps1" -Uninstall:$Uninstall
exit $LASTEXITCODE
