<#
.SYNOPSIS
  Publish the three spike executables side by side.

.DESCRIPTION
  All three must land in one directory: the supervisor locates the companion with
  SpikePaths.CompanionExe, which resolves relative to the running executable, and the
  supervisor's authorisation check compares the connecting process's image path against that
  exact path. Publishing them to separate folders would make every connection fail
  authorisation for a reason that looks like a security bug and is really a layout bug.
#>
[CmdletBinding()]
param(
    [string] $Configuration = 'Release',
    [string] $OutDir
)

$ErrorActionPreference = 'Stop'
$spikeRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $spikeRoot 'out' }

$projects = @(
    'src/Otondev.Spike.Service/Otondev.Spike.Service.csproj'
    'src/Otondev.Spike.Companion/Otondev.Spike.Companion.csproj'
    'src/Otondev.Spike.Probe/Otondev.Spike.Probe.csproj'
)

# A companion or supervisor left over from a previous run holds a file lock on the output and
# turns a rebuild into a confusing access-denied. Only this spike's own processes are touched.
$stale = Get-Process -Name 'Otondev.Spike.*' -ErrorAction SilentlyContinue
if ($stale) {
    Write-Host "stopping $($stale.Count) leftover spike process(es)..." -ForegroundColor DarkYellow
    $stale | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

# Best effort. A stale directory handle (indexer, antivirus, an Explorer window) can keep the
# folder alive for a few seconds after the last process exits, and publish overwrites in place
# anyway — failing the build over housekeeping would be the wrong trade.
if (Test-Path $OutDir) {
    try { Remove-Item -Recurse -Force $OutDir -ErrorAction Stop }
    catch { Write-Host "could not clear $OutDir ($($_.Exception.GetType().Name)); publishing over it" -ForegroundColor DarkYellow }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

foreach ($project in $projects) {
    $full = Join-Path $spikeRoot $project
    Write-Host "publishing $(Split-Path -Leaf $project)..." -ForegroundColor Cyan
    dotnet publish $full -c $Configuration -o $OutDir --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw "publish failed for $project" }
}

Write-Host ""
Write-Host "published to $OutDir" -ForegroundColor Green
Get-ChildItem $OutDir -Filter 'Otondev.Spike.*.exe' | ForEach-Object { Write-Host "  $($_.Name)" }
