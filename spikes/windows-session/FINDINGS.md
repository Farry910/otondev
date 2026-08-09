# SP1 — Windows session spike: findings

**Status: INCOMPLETE — no kill-or-continue verdict yet.** Do not clear the `windows-spike`
gate on the strength of this document. Four sub-questions are answered with evidence; the
central one is not, and the reason is environmental rather than technical.

Run on Windows 11 Pro 10.0.26200, .NET 10.0.300, session 1, **unelevated**.

---

## 1. What was actually established

Measured by `otondev-spike-harness.exe`; raw output in `results/unelevated.json`.

| Question | Result | Evidence |
|---|---|---|
| Can the supervisor find the right session without privilege? | **Yes** | 3 sessions enumerated, active console = 1, one interactive candidate correctly identified. `WTSEnumerateSessions`/`WTSQuerySessionInformation` need no elevation. |
| Is the privilege boundary the architecture assumes real? | **Yes** | `WTSQueryUserToken` from an unelevated process fails with `ERROR_PRIVILEGE_NOT_HELD` (1314). Only `SE_TCB_NAME` holders can obtain another session's user token. |
| Does a pipe ACL stop an unauthorized local caller? | **Yes** | A pipe granted only to `LocalService` refused our connect with `UnauthorizedAccessException` — *at the kernel*, before any application code ran. |
| Does the companion refuse a server it cannot attribute? | **Yes** | With no supervisor pipe present, the companion read a null owner and exited 78 without sending a byte. |

The second row is the useful one. It is easy to read "unelevated process cannot do X" as a
limitation of the test rig; it is the opposite. If an ordinary process *could* obtain a
session token, the session-0 service in `secure-box-and-supervision.md` would be
unnecessary and the isolation story would be substantially weaker than the document claims.
The design's central structural choice is justified.

## 2. A concrete implementation constraint for S17

Windows refuses to impersonate a named-pipe client until the server has read from the pipe.
`NamedPipeServerStream.RunAsClient` before the first read throws:

> Unable to impersonate using a named pipe until data has been read from that pipe.

So the server **cannot** identify its caller before reading the first frame. The ordering has
to be: accept → read one bounded frame → resolve the client SID → check the allow-list → only
then act on anything.

That is safe, because the DACL is the primary gate and the pre-authentication work is limited
to reading and parsing a length-bounded frame that is never acted upon. It is worth writing
down because the instinct — authenticate first, then read — is the correct instinct
everywhere else, and because the natural "optimisation" of folding registration into the
first command would quietly make it unsafe.

## 3. What is NOT established, and why

| Criterion | Status | Blocked by |
|---|---|---|
| A session-0 service launches an interactive companion in a real logged-in session | **Unproven** | Requires LocalSystem. This shell is not elevated, and elevation is an interactive UAC decision. |
| Survives reboot | **Unproven** | Requires restarting the host — it would end the operator's own session. |
| Survives logoff, lock, reconnect | **Unproven** | Each ends or suspends the session in use. Needs a dedicated test machine. |
| Companion drives a target app and reports a postcondition | **Unproven** | The driver is written (`AppDriver.DriveNotepad`: SendInput to write, UI Automation to read back, agreement is the postcondition) but was not executed to completion — see §4. |
| Companion runs non-administrator | **Unproven** | Same. |
| Start / reconnect latency, control plane unreachable | **Unproven** | Same. |
| IPC refuses a pipe squatted by a *different* local account | **Unproven** | Needs a second local user account. The owner check is implemented and proven against a missing pipe only. |

Nothing here is evidence that the design fails. It is evidence that the questions have not
been asked yet.

## 4. State of the code — read this before continuing

**The tree does not currently build.** It contains two overlapping implementations of the same
spike that were developed in parallel and are only half merged:

- **Spine (keep):** `SupervisorCore.cs`, `ServiceHost.cs` (real SCM service with
  `StartServiceCtrlDispatcher`, session-change control 0x0E, custom control codes 128/129 for
  containment), `Launch.cs`, `Protocol.cs` (the `Wire` message set), `IpcClient.cs`,
  `Evidence.cs`. This is the better design: it is an actual Windows service rather than a
  substitute, which is what criterion 1 asks for.
- **Superseded (delete):** `Common/SupervisorHost.cs`, `Supervisor/CompanionLauncher.cs`, and
  the `Otondev.Spike.Harness` project. Their behaviour is covered by the spine plus the
  evidence log.
- **Keep and re-target:** `Companion/AppDriver.cs` — the postcondition driver is independent
  of the wire protocol and is the answer to criterion 3.

Three concrete gaps:

1. `Supervisor/Program.cs` references `RunSupervisor(...)` and `Current`, neither of which is
   declared anywhere. It needs a `SupervisorCore` instance holder and a run loop that wires
   `ServeAsync` + `MonitorAsync` together.
2. `SupervisorCore.HandleClientAsync` speaks ad-hoc ops (`ready`/`heartbeat`/`result`/`health`)
   over `Ipc.Message`, while `Protocol.cs` defines a richer typed `Wire` set over
   `PipeChannel`. `Wire` is the one to keep — its payloads carry the fields the exit criteria
   need as evidence. `SupervisorCore` and the companion both need to be moved onto it.
3. `Companion/Program.cs` still speaks the old register/ack protocol and must be rewritten
   against `Wire` + `IpcClient.ConnectVerified`.

## 5. Next step

The remaining criteria need a **dedicated Windows test machine** and an operator willing to
reboot and log off it. On that machine, after the merge above:

```powershell
dotnet publish src/Otondev.Spike.Supervisor -c Release -o publish
dotnet publish src/Otondev.Spike.Companion  -c Release -o publish
# elevated:
sc.exe create OtondevSpikeSupervisor binPath= "<abs>\publish\otondev-supervisor.exe" start= auto
sc.exe start OtondevSpikeSupervisor
# then: lock, unlock, log off, log on, reboot — reading results/evidence.jsonl after each.
```

Until that runs, the honest verdict is **not yet determined**, and S16/S17 stay gated.
