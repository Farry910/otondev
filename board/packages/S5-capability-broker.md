# S5 — Capability and Credential Broker

```yaml
id: S5
status: todo
owner: ""
claimed_at: ""
branch: svc/S5-broker
stage: 1
depends_on: W0
gate: none
gate_cleared: yes
fake: no
```

**Owns** — `services/broker/**`, Postgres schema `broker`
**Spec** — implementation plan §5 · S5 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [contracts §6](../../doc/02-architecture/contracts-and-data.md), [security](../../doc/02-architecture/security-and-credentials.md)
**Fakes** — policy, audit
**Separate process** — the only component permitted to retrieve secrets

> **Security-critical.** Requires independent review before any package performs a real mutation
> against it. Do not move this card to `done` on your own judgment.

## Exit criteria

- [ ] signed capabilities binding subject, workflow, action ID, operation, resource, parameter constraints, `max_uses`, fencing token, expiry, revocation epoch
- [ ] secrets retrieved **only** for a trusted adapter; a secret value is never returned to a caller
- [ ] vault interface with a dev file-backed implementation and a DPAPI implementation for the demo
- [ ] the documented DPAPI recovery strategy exists (protection context loss is unrecoverable otherwise)
- [ ] revocation, epoch bump, rotation, and the emergency deny path
- [ ] the full verification matrix: signature, expiry, use count, fencing token, revocation epoch, parameter digest, resource
- [ ] a stale fencing token is rejected
- [ ] a secret value never appears in any contract, log, metric, artifact, or audit payload
- [ ] emergency deny propagates at p95 < 10 s
- [ ] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
