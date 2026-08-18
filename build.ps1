<#
.SYNOPSIS
  Repo-root wrapper for scripts/build.ps1.

.EXAMPLE
  .\build.ps1 && .\install.ps1
#>
[CmdletBinding()]
param(
  [string]$PublicRegistry = 'https://registry.npmjs.org/'
)

$ErrorActionPreference = 'Stop'
& "$PSScriptRoot\scripts\build.ps1" -PublicRegistry $PublicRegistry
exit $LASTEXITCODE
