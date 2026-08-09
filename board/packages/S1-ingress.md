# S1 — Event Ingress and Dedupe

```yaml
id: S1
status: done
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
- [x] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 14:57 | agent-sess-ec39663a | claimed
- 2026-08-09 15:07 | agent-sess-ec39663a | done - Landed 59cdc46. All 9 criteria met; 43 tests in services/ingress, 310 across the workspace, green offline with peers faked. Verified with npx tsc -b services/ingress --force, eslint, check-boundaries, check-path-ownership, vitest run -- all clean after rebase onto main. One caveat recorded as a contract request: the shared ingress conformance suite cannot distinguish a real signature verifier from a presence check (it sends 'x-signature: sig' and no timestamp), so the suite run wires a PresenceAuthenticator confined to src/testing/; the real HMAC path is covered in ingress.test.ts and a test asserts createIngressService refuses exactly what the suite accepts. Did not consume the workflow-engine fake: ingress does not create workflows -- the consumer wires ingress->workflow, as W0's example-consumer shows. Audit is consumed for every refusal at the front door.
