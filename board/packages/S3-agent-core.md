# S3 — Agent Core Runtime

```yaml
id: S3
status: blocked
owner: ""
claimed_at: ""
branch: svc/S3-core
stage: 1
gate: W0
fake: no
```

**Owns** — `services/core/**`, Postgres schema `core`
**Spec** — implementation plan §5 · S3 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [agent-core](../../doc/02-architecture/components/agent-core.md)
**Fakes** — all peers

> **Integration hotspot.** S3 touches every interface, so seam defects surface here first. Pair this
> card with S20, or review it at every S20 milestone.

## Exit criteria

- [ ] versioned identity record; persona never overrides policy or fabricates experience
- [ ] triage producing priority, skills match, risk, data class, and unknowns
- [ ] `DecisionRequest` construction; model output is **never** treated as authorization
- [ ] the named-resource concurrency table and priority ladder from agent-core
- [ ] status derived from workflow truth, with update coalescing and rate limiting
- [ ] restart recovery: reload identity, scan non-terminal workflows, fence, reconcile, resume
- [ ] concurrent meeting plus background task arbitrates without resource collision
- [ ] a completion claim with no supporting evidence is rejected
- [ ] operator pause during a model call, a test run, and delivery each contain safely
- [ ] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
