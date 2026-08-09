# S13 — Memory Service core

```yaml
id: S13
status: todo
owner: ""
claimed_at: ""
branch: svc/S13-memory
stage: 2
depends_on: W0
gate: none
gate_cleared: yes
fake: no
```

**Owns** — `services/memory/**`, Postgres schema `memory`
**Spec** — implementation plan §5 · S13 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [memory-service](../../doc/02-architecture/components/memory-service.md), [contracts §9](../../doc/02-architecture/contracts-and-data.md)
**Fakes** — cognition (reflection), policy, audit

> Build against a `MemoryStore` interface with a **SQLite reference implementation**. That is what
> takes the Ditto spike off this card's critical path — see S14.

## Exit criteria

- [ ] record classes with provenance, ACL, data class, valid time, retention, confidence, integrity
- [ ] the eight-step ingestion pipeline: eligibility, normalize, quarantine, classify, store source, derive, validate, index
- [ ] policy-filter-first retrieval returning citations and uncertainty
- [ ] tombstone and supersession propagation; the warm-set builder with expiry
- [ ] poison instructions in ticket, source, transcript, tool output, and synced record are all quarantined
- [ ] a repeatedly mentioned unsupported claim gains no authority
- [ ] correction and deletion traverse records, embeddings, summaries, warm sets, and indexes
- [ ] cross-tenant and cross-agent ACL isolation holds
- [ ] contradictory credible claims are both returned, with dates and status
- [ ] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
