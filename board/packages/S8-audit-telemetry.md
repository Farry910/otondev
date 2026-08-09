# S8 — Audit and Telemetry

```yaml
id: S8
status: blocked
owner: ""
claimed_at: ""
branch: svc/S8-audit
stage: 1
gate: W0
fake: no
```

**Owns** — `services/audit/**`, `packages/telemetry/**`, Postgres schema `audit`
**Spec** — implementation plan §5 · S8 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [operations §2](../../doc/05-operations/operations-and-evaluation.md), [security](../../doc/02-architecture/security-and-credentials.md) audit design
**Fakes** — none meaningful

## Exit criteria

- [ ] append-only audit writer with a verifiable hash chain
- [ ] WORM export interface with integrity verification
- [ ] schema-driven redaction — a secret-class field is **unpersistable by construction**, not filtered by string match
- [ ] OpenTelemetry conventions for logs, metrics, and traces
- [ ] bounded-cardinality metric registry: ticket IDs, prompts, filenames, and people can never become labels
- [ ] dashboards-as-code and the alert rules from operations §2
- [ ] the hash chain detects tampering
- [ ] sampling retains 100% of A3, security, policy, and emergency events
- [ ] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
