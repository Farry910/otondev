# S10 — Workspace and Sandbox Manager

```yaml
id: S10
status: blocked
owner: ""
claimed_at: ""
branch: svc/S10-workspace
stage: 1
gate: W0 + isolation spike
fake: no
```

**Owns** — `services/workspace/**`, Postgres schema `workspace`
**Spec** — implementation plan §5 · S10 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [secure box](../../doc/02-architecture/secure-box-and-supervision.md) worker lifecycle
**Fakes** — broker, audit
**Separate process** — runs untrusted repository code

> **Gated on delivery-plan Stage-0 spike 2.** The *interface* should be authored during W0 so S11 is
> not blocked; only the isolation implementation waits for the spike.
>
> **Security-critical.** Independent review required before `done`.

## Exit criteria

- [ ] fresh workspace per `(workflow, attempt)`; verified and pinned worker images
- [ ] deny-by-default network with an explicit allow-list; minimal mounts
- [ ] CPU, memory, disk, time, and spend limits; egress logging
- [ ] teardown and the quarantine path
- [ ] the escape suite reaches **nothing**: host socket, vault, cloud metadata, LAN, other workspaces, presence desktop
- [ ] quotas terminate rather than degrade
- [ ] teardown completes after a worker crash
- [ ] a fenced worker loses its publish capability
- [ ] fake and implementation both pass the shared conformance suite
- [ ] `pnpm test` green offline with all peers faked

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
