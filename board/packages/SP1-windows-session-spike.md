# SP1 — Windows session spike

```yaml
id: SP1
status: claimed
owner: agent-bbf05b75
claimed_at: 2026-08-09 14:30
heartbeat: 2026-08-09 14:30
reviewer: ""
branch: spike/SP1-windows-session
stage: 0
depends_on: 
gate: none
gate_cleared: yes
clears_gate: windows-spike
fake: n/a
owns: spikes/windows-session/**
```

**Owns** — `spikes/windows-session/**`
**Spec** — [delivery plan](../../doc/04-delivery/delivery-plan.md#stage-0--decisions-and-spikes-roughly-12-weeks) Stage-0 spike 1
**Read also** — [secure box](../../doc/02-architecture/secure-box-and-supervision.md) Windows session architecture, [external constraints](../../doc/06-decisions/external-constraints.md)
**Toolchain** — .NET, independent of the TypeScript control plane
**Unblocks** — S16, S17 (once a human clears `windows-spike`)

> **Kill-or-continue.** This is a spike, not a product package. Throwaway code is expected and
> correct; the deliverable is the **finding**, not the implementation. If the answer is "this cannot
> work as designed", say so plainly — that is a successful spike, and delivery plan Stage 0 is explicit
> that a failed spike changes architecture before product work.

## Exit criteria

- [ ] a session-0 service launches an interactive companion process in a real logged-in session
- [ ] the pair survives reboot, logoff, lock, and reconnect, or the exact failure mode is documented
- [x] the companion drives a target application and reports a postcondition, not just "the call returned"
- [ ] the companion runs **non-administrator** and the service never exposes a privileged UI
- [x] local IPC is mutually authenticated and ACL-restricted; an unauthorized local caller is rejected
- [x] measured: companion start latency, reconnect latency, and behaviour with the control plane unreachable
- [x] `spikes/windows-session/FINDINGS.md` records a **kill-or-continue verdict**, the evidence behind it, and the architecture consequences if it is "kill"
- [x] the finding names which S16/S17 exit criteria are now known to be reachable and which are still unproven

## Handing the result back

A human reads `FINDINGS.md` and, if the verdict is continue, runs:

```powershell
.\board\scripts\board.ps1 clear-gate S16 -Note "SP1: <verdict summary>"
.\board\scripts\board.ps1 clear-gate S17 -Note "SP1: <verdict summary>"
```

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 13:03 | agent-bbf05b75 | claimed
- 2026-08-09 13:19 | agent-bbf05b75 | released - Harness + reconciliation committed on spike/SP1-windows-session (not pushed). 4 sub-questions answered with evidence; the central criterion needs LocalSystem and reboot/logoff need a dedicated machine — see spikes/windows-session/FINDINGS.md. Needs a human decision on where to run it.
- 2026-08-09 13:51 | agent-sess-83866095 | claimed
- 2026-08-09 14:29 | agent-sess-83866095 | released - unelevated half complete and pushed (afc5136); 5/8 criteria ticked. Remaining 3 need an administrator: scripts/run-elevated.ps1 installs the LocalSystem service and closes them. FINDINGS.md says CONTINUE but do not clear windows-spike yet.
- 2026-08-09 14:29 | agent-sess-83866095 | claimed
- 2026-08-09 14:29 | agent-sess-83866095 | released - blocked on administrator access, not on engineering. 5/8 ticked and pushed (afc5136); the last 3 need scripts/run-elevated.ps1 from an elevated shell plus an operator to lock/logoff/reboot.
- 2026-08-09 14:30 | agent-bbf05b75 | claimed
