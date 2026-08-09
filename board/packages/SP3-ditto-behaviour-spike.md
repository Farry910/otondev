# SP3 — Ditto behaviour spike

```yaml
id: SP3
status: claimed
owner: agent-bbf05b75
claimed_at: 2026-08-09 14:00
heartbeat: 2026-08-09 14:13
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
- [ ] confirmed in the spike, not assumed: Ditto is unsuitable for work claims, approval uniqueness, fencing, and revocation
- [ ] `spikes/ditto-behaviour/FINDINGS.md` records a **kill-or-continue verdict**, the exact SDK and version tested, and which `MemoryStore` conformance cases the adapter can satisfy

## Handing the result back

```powershell
.\board\scripts\board.ps1 clear-gate S14 -Note "SP3: <verdict summary>"
```

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 14:00 | agent-bbf05b75 | claimed