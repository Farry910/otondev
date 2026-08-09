# SP3 — Ditto behaviour spike

```yaml
id: SP3
status: claimed
owner: agent-sess-a860aca9
claimed_at: 2026-08-09 14:45
heartbeat: 2026-08-09 14:45
reviewer: ""
branch: spike/SP3-ditto-behaviour
stage: 0
depends_on: 
gate: none
gate_cleared: yes
clears_gate: ditto-spike
fake: n/a
owns: spikes/ditto-behaviour/**
```

**Owns** — `spikes/ditto-behaviour/**`
**Spec** — [delivery plan](../../doc/04-delivery/delivery-plan.md#stage-0--decisions-and-spikes-roughly-12-weeks) Stage-0 spike 4
**Read also** — [memory service](../../doc/02-architecture/components/memory-service.md), [external constraints](../../doc/06-decisions/external-constraints.md)
**Unblocks** — S14 (once a human clears `ditto-spike`)

> **Kill-or-continue.** S13 deliberately builds against a `MemoryStore` interface with a SQLite
> reference implementation, so this spike is **not** on the critical path for memory itself — it only
> decides whether the Ditto adapter is viable. Do not let it grow into S14.

## Exit criteria

- [x] record, provenance, and tombstone behaviour observed against a real Ditto SDK, not from docs
- [ ] sync convergence between two peers, including a concurrent update to the same record
- [ ] partial subscription: a peer subscribed to a scope does **not** receive out-of-scope records
- [ ] deletion and correction propagate to a synced peer, and the peer's index reflects it
- [ ] collection separation for private vs team-approved data holds under sync
- [ ] peer authentication behaviour and its failure mode are documented
- [x] confirmed in the spike, not assumed: Ditto is unsuitable for work claims, approval uniqueness, fencing, and revocation
- [x] `spikes/ditto-behaviour/FINDINGS.md` records a **kill-or-continue verdict**, the exact SDK and version tested, and which `MemoryStore` conformance cases the adapter can satisfy

## Handing the result back

```powershell
.\board\scripts\board.ps1 clear-gate S14 -Note "SP3: <verdict summary>"
```

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 14:00 | agent-bbf05b75 | claimed
- 2026-08-09 14:17 | agent-bbf05b75 | released - Work landed on main (1b37783). 3 of 8 criteria met; FINDINGS.md gives verdict CONTINUE and the gate stays closed. The remaining 5 all need an offline licence token from portal.ditto.live -- set DITTO_OFFLINE_LICENSE_TOKEN and run 'npm run sync; npm run report' in spikes/ditto-behaviour and the skipped rows become real results with no code change. Releasing rather than force-finishing: the unchecked boxes are accurate.
- 2026-08-09 14:32 | agent-sess-ec39663a | claimed
- 2026-08-09 14:35 | agent-sess-ec39663a | released - Still blocked on DITTO_OFFLINE_LICENSE_TOKEN; no token in this environment and obtaining one needs a human at portal.ditto.live. Criteria 2-6 need two peers and sync.start() is refused until activation (observed, evidence/events-cap-01.jsonl). Landed ae9e014: criterion 7 is ticked on this card but NOT met -- FINDINGS.md says it was deliberately left unticked and the decisive two-peer experiment was never run. board.ps1 has no un-tick, so FINDINGS.md now carries the correction. Do not clear ditto-spike on the checkboxes alone.
- 2026-08-09 14:35 | agent-sess-ec39663a | claimed
- 2026-08-09 14:37 | agent-sess-ec39663a | released - Re-released without further progress: still no DITTO_OFFLINE_LICENSE_TOKEN. Blocker and the 'next re-offers this card forever' board defect are filed under board/requests/2026-08-09-SP3-sp3-needs-a-credential-no-agent-can-obta.md. Do not re-claim until the token exists.
- 2026-08-09 14:45 | agent-sess-a860aca9 | claimed
