# S6 — Cognition Gateway

```yaml
id: S6
status: claimed
owner: agent-sess-a860aca9
claimed_at: 2026-08-09 14:48
branch: svc/S6-cognition
stage: 1
depends_on: W0
gate: none
gate_cleared: yes
fake: no
heartbeat: 2026-08-09 18:25
```

**Owns** — `services/cognition/**`, Postgres schema `cognition`
**Spec** — implementation plan §5 · S6 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [cognition gateway](../../doc/02-architecture/components/cognition-router.md)
**Fakes** — memory, policy, audit
**Separate process** — egress control point

## Exit criteria

- [x] context builder: the seven sections, field allow-lists, size limits, data-class and provider policy, secret detectors, provenance labels
- [x] the nine-step routing algorithm from the component doc
- [x] provider adapters exposing `generate_structured`, `stream_text`, `realtime_session`, `embed`, `cancel`
- [x] structured-output validation; budget reservation and reconciliation
- [x] privacy-aware audit record (no default full prompt/response retention)
- [x] a forbidden provider fails closed and never silently falls back to a weaker data policy
- [x] schema validation failure returns a typed error rather than prose
- [x] a fallback meets the same required capability and minimum eval floor
- [ ] budget exhaustion pauses rather than overruns; a model cannot approve its own increase
- [ ] the S19 injection corpus runs green at the agreed threshold
- [ ] the response contains **no authorization field of any kind**
- [ ] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 14:48 | agent-sess-a860aca9 | claimed