# S12 — Verifier and Definition of Done

```yaml
id: S12
status: done
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
- [x] the verifier cannot publish, approve, or review its own executor's narrative
- [x] fake and implementation both pass the shared conformance suite
- [x] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 14:37 | agent-sess-ec39663a | claimed
- 2026-08-09 14:56 | agent-sess-ec39663a | done - Landed 39c3d23. All 11 criteria met; 61 tests in services/verifier, 267 across the workspace, green offline with peers faked. Verified with: npx tsc -b services/verifier --force (root typecheck does NOT cover services/* -- raised), eslint, check-boundaries, check-path-ownership, vitest run. Did not deepen FakeVerifier: it already passes the shared suite in zero-divergence parity with the real implementation, and the properties my package adds (skipped-never-pass under scripted checks, target-drift detection) cannot be expressed in a shared suite because VerifierClient exposes no way to drive check statuses. Three contract requests raised: root tsconfig not covering services/*, the SDK README's 'add real: to subjects.ts' instruction being forbidden by the sdk-is-implementation-free boundary rule, and no lockfile-freshness gate (which had broken main).
