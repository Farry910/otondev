# SP1 — Windows session spike: findings

## Verdict: **CONTINUE**, with the central criterion still unproven

Nothing found here says the presence architecture cannot work. The opposite: the structural
choice the design is built on — a non-interactive session-0 service plus a least-privilege
interactive companion — is **confirmed to be necessary**, and every property that could be
measured without administrator rights held.

**But do not clear the `windows-spike` gate on this document yet.** Two of the eight exit
criteria are unproven, and neither is unproven for a technical reason: criterion 1 needs a
LocalSystem service (an interactive UAC approval that was declined during this run) and
criterion 2 needs an operator willing to lock, sign out and reboot the machine. §5 is a single
command that closes both.

Evidence: `results/unelevated-report.md`, rendered from the run tagged `verify-3`.
Reproduce with `scripts/build.ps1` then `scripts/run-unelevated-pass.ps1`.

---

## 1. Host profile this holds for

| | |
|---|---|
| OS | Windows 11 Pro 10.0.26200, session 1, single interactive user |
| Toolchain | .NET 10.0.300, `net10.0-windows`, no NuGet dependencies beyond the SDK |
| Caller | `LAPTOP-17SBLA91\Fernando`, **not** elevated, integrity `Medium(0x2000)`, `WinSta0\Default` |
| Target application | Windows Notepad (not built by us, not cooperating on purpose) |

## 2. What held

| Property | Result | Evidence |
|---|---|---|
| The privilege boundary the design assumes is real | **Yes** | `WTSQueryUserToken` from an unelevated process fails `ERROR_PRIVILEGE_NOT_HELD` (1314). Only `SE_TCB_NAME` holders can obtain another session's token. |
| Companion runs non-administrator | **Yes** | Every companion that handshook: `elevated=False`, `administrator=False`, integrity `Medium(0x2000)`, window station `WinSta0`, desktop `Default`. |
| Companion drives a real app to a **postcondition** | **2/2** | Text typed into Notepad was read back from **the saved file on disk** *and* from the live UIA tree (`Document/ValuePattern`). Two independent readings, both required to pass. |
| Unauthorized local caller rejected | **8/8** | Probe, PowerShell, and a companion binary from a different directory all connected and were all refused. **0** admitted. |
| Companion refuses a rogue server | **Yes** | Against a squatted pipe it disconnected **without sending a byte** — the squatter reported `DEFENDED`. |
| Containment works with the control plane down | **Yes** | STOP sentinel → companion killed and **relaunch latched off**. No network in the path. |
| Pair survives the control plane being gone | **Yes** | Breaker opened; companion kept running and kept completing tasks. |

### Measurements

| Metric | n | Observed |
|---|---:|---|
| Companion start (launch → authenticated handshake) | 2 | 156 ms, 344 ms |
| Reconnect (kill → authenticated companion again) | 1 | 156 ms |
| Target-application task (launch, type, save, verify) | 2 | 2.44 s, 2.64 s |
| Local emergency stop (sentinel → reaction) | 2 | 47 ms, 172 ms |
| Time to notice the control plane is gone | 1 | 2015 ms (2 s connect timeout) |

> **These are same-session numbers.** The supervisor launched the companion with
> `Process.Start`, not `CreateProcessAsUser`. The cross-session path adds token duplication,
> `CreateEnvironmentBlock` and a window-station switch, so treat 156–344 ms as a floor, not a
> prediction. Every event carries its launch mode so no same-session number can be quoted as
> cross-session evidence by accident.

## 3. Three things S17 must not get wrong

**The pipe DACL is not an authentication mechanism on a single-user desktop.** The observed
DACL grants LocalSystem, Administrators, and the logged-on user. On the presence desktop the
companion *is* the logged-on user — so every process that user runs satisfies the DACL,
including anything they can be talked into launching. All eight rejections came from the
application-layer check (client PID → image path), not from the kernel. S17's criterion "IPC
ACLs hold against an unauthorized local caller" is therefore only satisfiable with a
per-process identity check behind the ACL. A dedicated companion account narrows the DACL but
does not remove the need.

**The client must authenticate the server, and almost nobody does.** Pipe names are an
unreserved machine-global namespace. An unprivileged process can create
`\\.\pipe\otondev-spike-supervisor` before the supervisor and harvest the companion's opening
frame — which carries session, user SID, and integrity level. The companion reads the pipe
object's **owner SID** before sending anything and refuses on mismatch; that is what produced
`DEFENDED`. Creating the first instance with `FirstPipeInstance` is the other half: it turns
squatting into a loud failure at supervisor startup instead of a silent handover.

**Containment has to latch.** An earlier revision killed the companion on the STOP sentinel and
let the supervise loop relaunch it 500 ms later — 13 launches in 6 seconds, two companions
fighting over one desktop. "Stopped" must mean stopped until a human clears it. This was caught
only because the harness logs every launch with a correlation id.

## 4. What is NOT established, and why

| Criterion | Status | Blocked by |
|---|---|---|
| A session-0 service launches an interactive companion in a real logged-on session | **Unproven** | Needs LocalSystem (`SE_TCB_NAME`). Installing the service needs administrator; the UAC prompt was declined during this run. The code path exists and is exercised by `scripts/run-elevated.ps1`. |
| Survives reboot, logoff, lock, reconnect | **Unproven** | Needs the service installed *and* an operator willing to lock, sign out and restart. No `OnSessionChange` notification was recorded, because a console process does not receive them — only a real service does. |

Neither row is evidence against the design. They are questions that have not been asked yet,
and §5 asks them.

## 5. How to close the gap

From an **administrator** PowerShell, after `scripts\build.ps1`:

```powershell
.\scripts\run-elevated.ps1          # installs the LocalSystem service, runs 90s, prints evidence
# while it runs: lock the workstation, unlock, sign out, sign back in
.\scripts\run-elevated.ps1 -Uninstall
```

Then re-read the report. Criterion 1 is met when a `companion.launch.ok` row shows
`mode=CrossSession` with a non-elevated token and `used_linked_token` recorded; criterion 2 is
met when `session.change` rows appear for lock/unlock/logon/logoff and a shutdown/start pair
brackets a reboot.

The service is throwaway and `-Uninstall` removes it completely.

## 6. S16/S17 exit criteria: reachable vs still unproven

**Known reachable** (measured here):

- S17 "mutually authenticated, ACL-restricted local IPC" — both directions, with the caveat in §3
- S17 "IPC ACLs hold against an unauthorized local caller" — 8/8 refused, 0 admitted
- S17 "the companion runs non-administrator" — measured off the live token, not asserted
- S17 "containment works with the control plane unreachable" — no network in the stop path
- S17 "health checks cover dependency readiness" — session, companion process, channel,
  heartbeat freshness and control-plane reachability are separate signals
- S16 "local emergency stop that works with the network and control plane down" — 47–172 ms
- S16 "adapter hierarchy … each with postconditions" — the postcondition discipline works: two
  independent readings, and the weaker one alone would have passed a wrong answer

**Still unproven:**

- S17 "launches and monitors the companion in the intended interactive session" — §4, needs LocalSystem
- S17 "survives reboot, logoff, lock, and reconnect" — §4, needs an operator
- S17 "never exposes a privileged UI" — structurally true (the service project references no UI
  framework and creates no window) but never exercised as an installed service
- S16 safe-share preflight, overlay, masking, notification-during-share — **not in scope of this
  spike at all**; SP1 covers the session and process architecture beneath them, nothing above it
- Anything about a second local account: the squat defence was proven against a rogue pipe owned
  by the *same* user. A different-account squatter needs a second account and was not tested.

## 7. Handing the result back

Not yet. When §5 has been run and criteria 1 and 2 are ticked on the card:

```powershell
.\board\scripts\board.ps1 clear-gate S16 -Note "SP1: <verdict summary>"
.\board\scripts\board.ps1 clear-gate S17 -Note "SP1: <verdict summary>"
```
