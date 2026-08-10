# S4 — Policy and Approval

```yaml
id: S4
status: claimed
owner: agent-bbf05b75
claimed_at: 2026-08-09 18:10
branch: svc/S4-policy
stage: 1
depends_on: W0
gate: none
gate_cleared: yes
fake: no
heartbeat: 2026-08-09 18:26
```

**Owns** — `services/policy/**`, Postgres schema `policy`
**Spec** — implementation plan §5 · S4 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [contracts §5](../../doc/02-architecture/contracts-and-data.md), [security](../../doc/02-architecture/security-and-credentials.md)
**Fakes** — audit

> **Security-critical.** Requires independent review before any package performs a real mutation
> against it. Do not move this card to `done` on your own judgment.

## Exit criteria

- [x] deterministic evaluation over actor, action, resource, environment, data class, provenance, incident mode, cost, approval
- [x] effective autonomy is the **minimum** across agent, repo, environment, data class, incident mode, and action type
- [x] signed, versioned policy bundles; decisions reproducible from logged inputs plus bundle hash
- [x] approval records bound to actor, action, normalized parameter digest, resource, environment, expiry, `max_uses`
- [x] editing any bound field invalidates the approval
- [x] a consumed or expired approval cannot be replayed
- [x] unknown or unclassified input **denies**
- [x] chat text, emoji, ticket labels, and model output never produce an approval record
- [ ] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 18:10 | agent-bbf05b75 | claimed