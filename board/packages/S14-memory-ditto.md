# S14 — Ditto storage adapter

```yaml
id: S14
status: todo
owner: ""
claimed_at: ""
branch: svc/S14-memory-ditto
stage: 2
depends_on: S13
gate: ditto-spike
gate_cleared: no
fake: no
```

**Owns** — `services/memory-ditto/**`
**Spec** — implementation plan §5 · S14 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [memory-service](../../doc/02-architecture/components/memory-service.md) Ditto boundary, [external constraints](../../doc/06-decisions/external-constraints.md)

> **Gated on delivery-plan Stage-0 spike 4.** Ditto's exact SDK, version, and deployment are still
> undecided.

## Exit criteria

- [ ] implements `MemoryStore` over Ditto
- [ ] collection separation: private per-agent, approved team knowledge, sync metadata
- [ ] subscription scope, conflict behaviour, tombstone rules, peer authentication
- [ ] private `people` profiles do not sync by default; shared procedures require explicit publish status
- [ ] passes the **same** `MemoryStore` conformance suite as the SQLite reference implementation
- [ ] partial-subscription and concurrent-update behaviour tested per collection
- [ ] never used for work claims, approval uniqueness, fencing tokens, or security revocation
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
