# Operator control service requirements

**Code:** OPC  
**Owns:** pause, cancellation, revocation, quarantine, takeover, and safe configuration control  
**Direct dependencies:** SUP, WFE, POL, CAP, AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Keep a human in operational control of the agent and its blast radius.

## Requirements

- **OPC-01:** Operators can pause work or agent, cancel task, revoke capability, quarantine worker,
  stop UI, mute or remove meeting presence, and shut down.
- **OPC-02:** Emergency controls MUST NOT depend on COR or a cloud model.
- **OPC-03:** Pause or revocation prevents new mutations immediately and fences active work within
  target.
- **OPC-04:** Resume requires task, worker, lease, credential, and external-state reconciliation.
- **OPC-05:** Operator action requires authentication, authorization, reason, and audit.
- **OPC-06:** Dashboards expose health and state without secret or unauthorized content.
- **OPC-07:** Configuration changes are validated, previewable, versioned, and reversible.

## Acceptance

Emergency control stops execution and UI when core and cloud providers are unavailable.

## Related requirements

- [Supervisor and lifecycle](./supervisor-lifecycle.md)
- [Capability and credential broker](./capability-credential-broker.md)
- [Audit and telemetry](./audit-telemetry.md)
