# S17 — Windows Supervisor

```yaml
id: S17
status: todo
owner: ""
claimed_at: ""
branch: svc/S17-supervisor
stage: 3
depends_on: 
gate: windows-spike
gate_cleared: no
fake: no
```

**Owns** — `windows/supervisor/**`
**Spec** — implementation plan §5 · S17 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [secure box](../../doc/02-architecture/secure-box-and-supervision.md) Windows session architecture
**Separate process** — session 0, non-interactive
**Toolchain** — .NET

> **Gated on delivery-plan Stage-0 spike 1.** Modern Windows services cannot interact with the user
> desktop; this split is mandatory, not stylistic — see [external constraints](../../doc/06-decisions/external-constraints.md).

## Exit criteria

- [ ] session-0 service: health, update, session discovery, companion lifecycle, emergency containment
- [ ] mutually authenticated, ACL-restricted local IPC endpoint
- [ ] never exposes a privileged UI; never accepts unauthenticated IPC
- [ ] launches and monitors the companion in the intended interactive session
- [ ] survives reboot, logoff, lock, and reconnect
- [ ] IPC ACLs hold against an unauthorized local caller
- [ ] the companion runs non-administrator
- [ ] containment works with the control plane unreachable
- [ ] health checks cover dependency readiness, not just "the heartbeat loop ran"

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
