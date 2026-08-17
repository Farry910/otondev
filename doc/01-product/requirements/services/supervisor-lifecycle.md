# Supervisor and lifecycle service requirements

**Code:** SUP  
**Owns:** component health, startup, restart, leases, reconciliation, and recovery mode  
**Direct dependencies:** IDN, WFE, AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Make one Agent Dev appear continuous while individual processes and dependencies may fail.

## Requirements

- **SUP-01:** Start components in dependency order and deny mutations until identity, policy,
  workflow, capability, and audit checks are healthy.
- **SUP-02:** Detect failed or unresponsive components through health checks and heartbeats.
- **SUP-03:** Restart recoverable components with bounded backoff and crash-loop protection.
- **SUP-04:** Keep workflow, memory, approval, and audit state outside component process memory.
- **SUP-05:** Use fencing tokens or equivalent leases so replaced workers cannot commit stale results.
- **SUP-06:** Reconcile processes, external mutations, leases, and checkpoints before recovery.
- **SUP-07:** Enter safe mode if audit, policy, revocation, or durable workflow state is unavailable.
- **SUP-08:** Version, validate, audit, and roll back component configuration.

## Acceptance

Killing core, executor, and supervisor before and after external writes produces safe recovery and no
duplicate mutation.

## Related requirements

- [Identity, role, and persona](./identity-role-persona.md)
- [Workflow orchestration](./workflow-orchestration.md)
- [Audit and telemetry](./audit-telemetry.md)
- [Platform infrastructure dependencies](../dependencies/platform-infrastructure.md)
