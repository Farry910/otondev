# Connector and tool gateway requirements

**Code:** CON  
**Owns:** typed, policy-controlled access to external APIs and developer tools  
**Direct dependencies:** POL, CAP, AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Give services reliable and replaceable access to team systems and development tools.

## Requirements

- **CON-01:** Every external operation uses a versioned, validated adapter contract.
- **CON-02:** Adapters declare read/write behavior, capability, autonomy, idempotency, timeout, retry
  safety, and audit fields.
- **CON-03:** Writes use idempotency keys or equivalent reconciliation.
- **CON-04:** Recheck intent and policy immediately before dispatch.
- **CON-05:** Normalize provider errors while preserving protected diagnostics.
- **CON-06:** Every connector provides a fake or sandbox for offline workflow tests.
- **CON-07:** Demo adapters cover one ticket, source-control/PR, and team-channel platform.
- **CON-08:** Monitoring, database, cloud, IDE, browser, and meeting tools use the same contract.
- **CON-09:** Prefer API/CLI for reliable private execution and UI for unsupported work or demos.
- **CON-10:** Reconcile uncertain writes before retry.

## Acceptance

Contract tests pass against fakes, and repeated delivery creates one external update.

## Related requirements

- [Team platform dependencies](../dependencies/team-platforms.md)
- [Runtime and desktop dependencies](../dependencies/runtime-desktop.md)
- [Capability and credential broker](./capability-credential-broker.md)
