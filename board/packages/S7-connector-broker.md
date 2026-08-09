# S7 — Connector Broker

```yaml
id: S7
status: todo
owner: ""
claimed_at: ""
branch: svc/S7-connectors
stage: 1
depends_on: W0
gate: none
gate_cleared: yes
fake: no
```

**Owns** — `services/connectors/**`, Postgres schema `actions`
**Spec** — implementation plan §5 · S7 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [contracts §6–7](../../doc/02-architecture/contracts-and-data.md), [task-engine](../../doc/02-architecture/components/task-engine.md) external mutations
**Fakes** — broker, policy, audit; recorded HTTP fixtures per provider

## Exit criteria

- [ ] adapter contract: `execute`, `lookup`/`reconcile`, and `compensate` where possible
- [ ] the `agentdev.action.v2` lifecycle: `prepared → sent → succeeded | failed | outcome_unknown`
- [ ] idempotency keys, and capability verification on every call
- [ ] GitHub, Jira, and Slack adapters
- [ ] an ambiguous timeout sets `outcome_unknown`, and **automatic retry is refused** until reconciliation says absent
- [ ] replay produces no duplicate PR, comment, or ticket transition
- [ ] compensation behaves per action class; a push or notification records its limitation instead
- [ ] a parameter mismatch against the capability digest is rejected
- [ ] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
