# S11 — Task Executor and Tool Runner

```yaml
id: S11
status: blocked
owner: ""
claimed_at: ""
branch: svc/S11-executor
stage: 1
gate: W0 + S10 policy shape
fake: no
```

**Owns** — `services/executor/**`
**Spec** — implementation plan §5 · S11 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [task-engine](../../doc/02-architecture/components/task-engine.md) workspace and command policy
**Fakes** — workspace, cognition, broker, connectors
**Separate process** — must not share a process with the verifier

## Exit criteria

- [ ] plan-step execution against the approved coding-adapter interface
- [ ] tool runner with executable and argument allow-lists, working directory and environment allow-list
- [ ] timeouts, output caps, streaming bounded logs, cancellation tokens
- [ ] checkpoints after deterministic milestones — never a blind replay journal
- [ ] a malicious ticket, source comment, or test output attempting tool escalation is contained
- [ ] budget exhaustion and cancellation both stop cleanly
- [ ] a base-SHA change mid-execution returns to planning rather than improvising
- [ ] tool output is treated as untrusted and size-bounded; large output becomes an artifact
- [ ] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
