<#
.SYNOPSIS
  Install, run and observe the spike supervisor as a real session-0 Windows service.

.DESCRIPTION
  This is the half of the spike that cannot be done without administrator rights, and it is the
  half that answers the central question: can a service in session 0 launch an interactive
  companion into a logged-on user's session?

  Everything the unelevated pass proves — IPC authentication, the postcondition drive, the
  measurements — is re-proved here through the real path, because same-session results are not
  evidence for a cross-session claim.

  The service is installed as LocalSystem because that is the only account that holds
  SE_TCB_NAME, which WTSQueryUserToken requires. That is not a convenience: the unelevated pass
  measured the refusal (ERROR_PRIVILEGE_NOT_HELD) that makes it necessary.

.PARAMETER Uninstall
  Stop and delete the service, then exit. Safe to run at any time.

.PARAMETER ObserveSeconds
  How long to let the pair run before reporting. The default gives the supervisor time to launch
  the companion, complete at least one target-application task, and heartbeat.

.EXAMPLE
  # from an elevated PowerShell, after scripts\build.ps1
  .\scripts\run-elevated.ps1

.EXAMPLE
  .\scripts\run-elevated.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch] $Uninstall,
    [int]    $ObserveSeconds = 90,
    [string] $BinDir
)

$ErrorActionPreference = 'Stop'
$spikeRoot = Split-Path -Parent $PSScriptRoot
if (-not $BinDir) { $BinDir = Join-Path $spikeRoot 'out' }

$ServiceName = 'OtondevSpikeSupervisor'
$ServiceExe  = Join-Path $BinDir 'Otondev.Spike.Service.exe'

function Test-Administrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
    Write-Host ''
    Write-Host 'This script must run elevated. It installs a LocalSystem service.' -ForegroundColor Yellow
    Write-Host 'Start an administrator PowerShell and run it again, or:' -ForegroundColor Yellow
    Write-Host "  Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-File','$PSCommandPath'" -ForegroundColor Cyan
    exit 2
}

function Remove-SpikeService {
    $existing = & sc.exe query $ServiceName 2>&1
    if ($LASTEXITCODE -ne 0) { return $false }

    Write-Host "stopping and deleting $ServiceName..." -ForegroundColor Cyan
    & sc.exe stop $ServiceName  | Out-Null
    # The SCM deletes lazily; poll rather than sleeping a guessed interval.
    for ($i = 0; $i -lt 40; $i++) {
        & sc.exe query $ServiceName > $null 2>&1
        if ($LASTEXITCODE -ne 0) { break }
        $state = (& sc.exe query $ServiceName) -join ' '
        if ($state -match 'STOPPED') { break }
        Start-Sleep -Milliseconds 250
    }
    & sc.exe delete $ServiceName | Out-Null
    for ($i = 0; $i -lt 40; $i++) {
        & sc.exe query $ServiceName > $null 2>&1
        if ($LASTEXITCODE -ne 0) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $true
}

if ($Uninstall) {
    if (Remove-SpikeService) { Write-Host "$ServiceName removed." -ForegroundColor Green }
    else { Write-Host "$ServiceName was not installed." }
    exit 0
}

if (-not (Test-Path $ServiceExe)) {
    throw "$ServiceExe not found. Run scripts\build.ps1 first."
}

Remove-SpikeService | Out-Null

Write-Host "installing $ServiceName -> $ServiceExe" -ForegroundColor Cyan
# The spaces after each '=' are required by sc.exe; without them it silently misparses.
& sc.exe create $ServiceName binPath= "`"$ServiceExe`"" start= demand obj= LocalSystem `
    DisplayName= 'Otondev SP1 spike supervisor' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc create failed with $LASTEXITCODE" }

& sc.exe description $ServiceName 'Throwaway spike service for otondev SP1. Safe to delete.' | Out-Null

# Restart-on-failure is part of what "survives" means for criterion 2: the supervisor is
# supposed to come back by itself, not because an operator noticed.
& sc.exe failure $ServiceName reset= 60 actions= restart/5000/restart/5000/restart/5000 | Out-Null

Write-Host "starting $ServiceName..." -ForegroundColor Cyan
& sc.exe start $ServiceName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc start failed with $LASTEXITCODE" }

$deadline = (Get-Date).AddSeconds($ObserveSeconds)
Write-Host ""
Write-Host "running for ${ObserveSeconds}s. While it runs, exercise criterion 2 by hand:" -ForegroundColor Green
Write-Host "  lock the workstation (Win+L), unlock it, and — on a machine you can afford to —"
Write-Host "  sign out and back in. Each one should appear as a session.change event."
Write-Host ""

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $q = (& sc.exe query $ServiceName) -join ' '
    if ($q -notmatch 'RUNNING') {
        Write-Host "service is no longer RUNNING:" -ForegroundColor Yellow
        Write-Host $q
        break
    }
}

Write-Host ""
Write-Host "=== evidence ===" -ForegroundColor Green
$probe = Join-Path $BinDir 'Otondev.Spike.Probe.exe'
if (Test-Path $probe) { & $probe report }

Write-Host ""
Write-Host "the service is still installed so you can lock/logoff/reboot and re-run:" -ForegroundColor Cyan
Write-Host "  $probe report"
Write-Host "remove it with:" -ForegroundColor Cyan
Write-Host "  .\scripts\run-elevated.ps1 -Uninstall"
