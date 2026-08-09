# S12 — Verifier and Definition of Done

```yaml
id: S12
status: claimed
owner: agent-sess-ec39663a
claimed_at: 2026-08-09 14:37
branch: svc/S12-verifier
stage: 1
depends_on: W0
gate: none
gate_cleared: yes
fake: no
heartbeat: 2026-08-09 14:53
```

**Owns** — `services/verifier/**`
**Spec** — implementation plan §5 · S12 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [task-engine](../../doc/02-architecture/components/task-engine.md) definition of done
**Fakes** — workspace, evidence
**Separate process** — independent of the executor, and holds **no publish capability**

## Exit criteria

- [x] versioned verifier manifest parser and validator
- [x] check execution against the immutable diff and commit
- [x] receives goal, diff, definition of done, and evidence — **never the executor's narrative**
- [x] explicit recording of skipped and unavailable checks
- [x] verdict plus known limitations; diff, secret, and licence scanning hooks
- [x] executor says pass while verifier fails resolves as **fail**
- [x] "skipped" is never reported as pass; "best effort" is not equivalent to pass
- [x] a manifest version mismatch fails closed
- [ ] the verifier cannot publish, approve, or review its own executor's narrative
- [x] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 14:37 | agent-sess-ec39663a | claimed