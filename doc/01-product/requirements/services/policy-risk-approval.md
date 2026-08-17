# Policy, risk, and approval service requirements

**Code:** POL  
**Owns:** deterministic authorization, risk evaluation, approvals, and emergency denies  
**Direct dependencies:** IDN, AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Make deterministic authorization decisions independently of model persuasion.

## Requirements

- **POL-01:** The same versioned inputs MUST produce the same decision.
- **POL-02:** Results are allow, deny, require-approval, or require-information with matched rules.
- **POL-03:** Evaluate identity, action, normalized parameters, target, environment, data class, risk,
  task, time, budget, and approval.
- **POL-04:** Approval is exact, expiring, non-transferable, and single-use when needed.
- **POL-05:** Policy changes require authorized review, versioning, pre-activation tests, and rollback.
- **POL-06:** Deny and emergency rules take precedence.
- **POL-07:** Reject stale plans, approvals, or parameters differing from authorization.
- **POL-08:** Govern models, connectors, memory, meetings, screen sharing, evidence, and credentials.
- **POL-09:** Fail closed for mutations during policy outage.

## Acceptance

Parameter changes, expiry, wrong identity or environment, and approval text injected through content
are denied.

## Related requirements

- [Identity, role, and persona](./identity-role-persona.md)
- [Capability and credential broker](./capability-credential-broker.md)
- [Security and privacy](../../requirements.md#11-security-and-privacy)
