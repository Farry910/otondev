# Identity, role, and persona service requirements

**Code:** IDN  
**Owns:** agent identity, owner, role, skills, persona versions, and project scopes  
**Direct dependencies:** AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Give each agent a stable, transparent identity and constrained engineering specialization.

## Requirements

- **IDN-01:** Each agent MUST have an immutable ID and versioned display name, automation label,
  owner, role, skills, policies, provider preferences, project scopes, and budgets.
- **IDN-02:** Roles define capabilities and preferences but MUST NOT grant authority beyond policy.
- **IDN-03:** Persona MAY shape tone but MUST NOT override evidence, disclosure, or policy.
- **IDN-04:** The agent MUST identify itself as automated in profiles and meetings unless the platform
  provides an equivalent persistent bot indicator.
- **IDN-05:** Identity and role changes MUST be authorized, versioned, and audited.
- **IDN-06:** Actions and messages MUST carry agent, task, session, and software-version identity.
- **IDN-07:** An agent MUST NOT represent a person or another agent without visible delegation.

## Acceptance

Every action maps to one identity and configuration version, and persona changes cannot expand
permissions.

## Related requirements

- [Audit and telemetry](./audit-telemetry.md)
- [Policy, risk, and approval](./policy-risk-approval.md)
- [Team platform dependencies](../dependencies/team-platforms.md)
