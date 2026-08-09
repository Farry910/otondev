# S18 — Operator Control and Emergency Stop

```yaml
id: S18
status: blocked
owner: ""
claimed_at: ""
branch: svc/S18-operator
stage: 1
gate: W0-E hooks
fake: no
```

**Owns** — `services/operator/**`
**Spec** — implementation plan §5 · S18 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [security](../../doc/02-architecture/security-and-credentials.md) emergency controls
**Depends on** — the `deny()` / `quarantine()` / `revoke()` hook interface from W0-E, implemented by every service

## Exit criteria

- [ ] operator API and CLI: pause agent, deny new work and capabilities, cancel workflow, revoke tokens, quarantine worker
- [ ] out-of-band authentication with RBAC and MFA, or a signed administrative command
- [ ] a chat command may be an interface but is **never** the authority by itself
- [ ] the six-step emergency sequence executes **in order**: deny new → revoke outstanding → fence leases → cancel activity → quarantine → preserve evidence and notify
- [ ] deny propagates at p95 < 10 s
- [ ] stop works with the network or control plane degraded
- [ ] containment is **verified and reported**, not merely requested
- [ ] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
