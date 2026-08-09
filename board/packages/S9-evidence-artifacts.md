# S9 — Evidence and Artifact Store

```yaml
id: S9
status: todo
owner: ""
claimed_at: ""
branch: svc/S9-evidence
stage: 1
depends_on: W0
gate: none
gate_cleared: yes
fake: no
```

**Owns** — `services/evidence/**`, Postgres schema `evidence`, object store adapters
**Spec** — implementation plan §5 · S9 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [contracts §10](../../doc/02-architecture/contracts-and-data.md), [task-engine](../../doc/02-architecture/components/task-engine.md) evidence bundle
**Fakes** — audit

## Exit criteria

- [ ] content-addressed encrypted artifact store with filesystem and S3-compatible implementations
- [ ] retention and lifecycle policy; log hashing
- [ ] assembly and signing of the immutable `agentdev.evidence.v2` bundle
- [ ] corrections create a **superseding** bundle; the original is never mutated
- [ ] the delivery gate rejects an incomplete bundle
- [ ] digests are stable across re-assembly
- [ ] retention expiry and the artifact scan hook both fire
- [ ] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
