<#
.SYNOPSIS
  Everything the spike can prove without administrator rights.

.DESCRIPTION
  Runs the supervisor in console mode (same-session launch) and exercises, in order:

    - companion launch, authenticated IPC in both directions, heartbeats
    - the target application drive and its on-disk + UIA postcondition
    - an unauthorized local caller against the supervisor pipe
    - emergency stop via the STOP sentinel, and recovery afterwards
    - control-plane-unreachable behaviour throughout
    - a rogue pipe server against a companion, in a separate phase

  What it does NOT prove is the cross-session launch itself, which needs SE_TCB_NAME and
  therefore a real session-0 service. Every event this script produces is tagged SameSession
  so the two can never be confused in the report.

.NOTES
  Briefly steals foreground focus and drives Notepad. It opens and closes its own tab and
  never terminates a shared Notepad instance.
#>
[CmdletBinding()]
param(
    [string] $RunId = "unelev-$(Get-Date -Format 'MMdd-HHmm')",
    [int]    $DurationSeconds = 100
)

$ErrorActionPreference = 'Stop'
$out = Join-Path (Split-Path -Parent $PSScriptRoot) 'out'
$service   = Join-Path $out 'Otondev.Spike.Service.exe'
$companion = Join-Path $out 'Otondev.Spike.Companion.exe'
$probe     = Join-Path $out 'Otondev.Spike.Probe.exe'

foreach ($exe in @($service, $companion, $probe)) {
    if (-not (Test-Path $exe)) { throw "missing $exe - run scripts\build.ps1 first" }
}

$env:OTONDEV_SPIKE_RUN = $RunId
Write-Host "run id: $RunId" -ForegroundColor Cyan

Write-Host "`n[0] preflight" -ForegroundColor Yellow
& $probe clean | Out-Null
& $probe preflight

Write-Host "`n[1] supervisor (console, same-session) for ${DurationSeconds}s" -ForegroundColor Yellow
$log = Join-Path $env:TEMP "otondev-spike-supervisor-$RunId.log"
$supervisor = Start-Process -FilePath $service `
    -ArgumentList '--console', '--duration', $DurationSeconds, '--interval', '30' `
    -NoNewWindow -PassThru -RedirectStandardOutput $log

Start-Sleep -Seconds 20   # let the first companion handshake and finish one target-app task

Write-Host "`n[2] unauthorized local caller vs the supervisor pipe" -ForegroundColor Yellow
& $probe intruder
$intruderExit = $LASTEXITCODE

Start-Sleep -Seconds 5

Write-Host "`n[3] emergency stop via sentinel (control plane is unreachable throughout)" -ForegroundColor Yellow
& $probe stop
Start-Sleep -Seconds 6
& $probe resume
Write-Host "    sentinel cleared; supervisor should relaunch the companion"

Write-Host "`n[4] waiting for the supervisor run to end..." -ForegroundColor Yellow
$supervisor | Wait-Process -Timeout ($DurationSeconds + 30)
Get-Content $log -Tail 12 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

Write-Host "`n[5] rogue pipe server vs a companion" -ForegroundColor Yellow
# The squatter can only claim the name once the supervisor has released it, which is why this
# phase runs after the supervisor exits. The companion is told to expect a LocalSystem-owned
# pipe; the squatter's pipe is owned by an ordinary user, so a correct companion refuses it.
$squatter = Start-Process -FilePath $probe -ArgumentList 'squatter', '--seconds', '25' `
    -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $env:TEMP "otondev-spike-squatter-$RunId.log")
Start-Sleep -Seconds 3
& $companion --launch squat-test --launch-tick 0 --reason squat-test --expect-server-owner 'S-1-5-18'
$companionExit = $LASTEXITCODE
Write-Host "    companion exit code: $companionExit (3 = refused the server's identity)"
$squatter | Wait-Process -Timeout 40
Get-Content (Join-Path $env:TEMP "otondev-spike-squatter-$RunId.log") | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

Write-Host "`n[6] report" -ForegroundColor Yellow
$reportPath = Join-Path (Split-Path -Parent $PSScriptRoot) "evidence-$RunId.md"
& $probe report --run $RunId --out $reportPath

Write-Host "`nintruder exit: $intruderExit (0 = rejected, 2 = ADMITTED, which is a defect)" -ForegroundColor Cyan
Write-Host "companion vs rogue server exit: $companionExit (3 = refused)" -ForegroundColor Cyan
Write-Host "evidence written to $reportPath" -ForegroundColor Green
