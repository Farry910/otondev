# S1 — Event Ingress and Dedupe

```yaml
id: S1
status: claimed
owner: agent-sess-ec39663a
claimed_at: 2026-08-09 14:57
branch: svc/S1-ingress
stage: 1
depends_on: W0
gate: none
gate_cleared: yes
fake: no
heartbeat: 2026-08-09 15:06
```

**Owns** — `services/ingress/**`, Postgres schema `ingress`
**Spec** — implementation plan §5 · S1 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [contracts §2](../../doc/02-architecture/contracts-and-data.md), [agent-core](../../doc/02-architecture/components/agent-core.md) event lifecycle
**Fakes** — workflow engine, audit

## Exit criteria

- [x] per-source webhook signature verification, replay window, schema and size limits
- [x] normalization to `agentdev.event.v2` with untrusted fields explicitly labelled
- [x] dedupe on `(tenant, source, source_event_id)`; a duplicate returns the **existing** canonical event ID
- [x] acknowledge only after authentication, dedupe persistence, **and** durable enqueue all succeed
- [x] out-of-order source version is retained and does not roll state backward
- [x] bad signature, oversized payload, and unknown schema major all fail closed
- [x] crash between persist and ack neither loses nor duplicates an acknowledged event
- [x] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 14:57 | agent-sess-ec39663a | claimed