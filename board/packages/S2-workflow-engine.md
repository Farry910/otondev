# S2 — Workflow Engine

```yaml
id: S2
status: claimed
owner: agent-sess-83866095
claimed_at: 2026-08-09 14:30
branch: svc/S2-workflow
stage: 1
depends_on: W0
gate: none
gate_cleared: yes
fake: no
heartbeat: 2026-08-09 14:42
```

**Owns** — `services/workflow/**`, Postgres schema `workflow`
**Spec** — implementation plan §5 · S2 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [contracts §3](../../doc/02-architecture/contracts-and-data.md#3-workflow-record-and-state-machine)
**Fakes** — everything

> Build behind a `WorkflowEngine` interface. The Temporal-vs-Postgres decision stays open until the
> crash/idempotency spike reports; a Postgres reference implementation is needed regardless.

## Exit criteria

- [ ] the full state machine from contracts §3, with compare-and-set on `state_version`
- [ ] leases carrying owner, expiry, and **fencing token**; timers and wakeups; retry and backoff
- [ ] a transition event persisted for every state change
- [ ] compensation hooks and the recovery scan for interrupted attempts
- [ ] two claimants on one workflow: exactly one wins
- [ ] an expired worker's write is fenced and rejected
- [ ] crash mid-transition resumes at a safe state
- [ ] terminal states reject all further transitions
- [ ] pause and cancel complete **only after** capabilities are denied and the lease is fenced
- [ ] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 14:30 | agent-sess-83866095 | claimed