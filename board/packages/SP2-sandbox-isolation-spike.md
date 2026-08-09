# SP2 — Sandbox isolation spike

```yaml
id: SP2
status: claimed
owner: agent-bbf05b75
claimed_at: 2026-08-09 13:25
heartbeat: 2026-08-09 13:53
reviewer: ""
branch: spike/SP2-sandbox-isolation
stage: 0
depends_on: 
gate: none
gate_cleared: yes
clears_gate: isolation-spike
fake: n/a
owns: spikes/sandbox-isolation/**
```

**Owns** — `spikes/sandbox-isolation/**`
**Spec** — [delivery plan](../../doc/04-delivery/delivery-plan.md#stage-0--decisions-and-spikes-roughly-12-weeks) Stage-0 spike 2
**Read also** — [secure box](../../doc/02-architecture/secure-box-and-supervision.md), [security and credentials](../../doc/02-architecture/security-and-credentials.md)
**Unblocks** — S10, and S11 behind it (once a human clears `isolation-spike`)

> **Kill-or-continue.** The deliverable is the **finding**. This spike answers whether the isolation
> model in the architecture is achievable on the chosen host profile at all — the highest-reach
> unknown on the board, because S10 gates S11 and both gate the whole execution plane.

## Exit criteria

- [x] a workspace runs the target repository's real test suite to completion inside the sandbox
- [ ] the escape suite fails to reach **every** one of: host socket, vault, cloud metadata endpoint, LAN, another workspace
- [ ] deny-by-default egress with an explicit allow-list, and egress is logged
- [ ] CPU, memory, disk, and wall-clock quotas **terminate** rather than degrade
- [ ] teardown completes after a deliberate worker crash, leaving nothing mounted or running
- [ ] measured: cold workspace create, warm create, and teardown times
- [ ] `spikes/sandbox-isolation/FINDINGS.md` records a **kill-or-continue verdict**, the host profile it holds for, and the residual risks
- [ ] the finding states which S10 exit criteria are now known reachable and which remain unproven

## Handing the result back

```powershell
.\board\scripts\board.ps1 clear-gate S10 -Note "SP2: <verdict summary>"
```

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 13:25 | agent-bbf05b75 | claimed