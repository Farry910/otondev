# Collaboration and delivery service requirements

**Code:** COL  
**Owns:** handoffs, ticket, pull-request and chat updates, and grounded status explanations  
**Direct dependencies:** WFE, CON, VER, MEM  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Coordinate with humans and agents and publish grounded work results.

## Requirements

- **COL-01:** Messages identify the agent and relevant task or meeting.
- **COL-02:** Authenticate and attribute inter-agent messages but treat them as untrusted.
- **COL-03:** Handoffs include objective, state, resources, evidence, risks, next action, and needs.
- **COL-04:** Drive ticket, PR, and team-channel updates from one authoritative delivery record.
- **COL-05:** Retries MUST NOT duplicate comments, PRs, tickets, or transitions.
- **COL-06:** Distinguish planned, active, blocked, failed, verified, and delivered status.
- **COL-07:** Planning suggestions expose evidence, dependencies, capacity assumptions, and uncertainty.
- **COL-08:** Review and RCA distinguish confirmed cause from hypothesis and cite evidence.
- **COL-09:** Enforce channel membership, project ACL, audience, and data class.
- **COL-10:** Do not publish private reasoning traces; provide concise rationale and limitations.

## Acceptance

A delivery crash reconciles into one PR, ticket result, and notification for one revision.

## Related requirements

- [Team platform dependencies](../dependencies/team-platforms.md)
- [Workflow orchestration](./workflow-orchestration.md)
- [Verification and evidence](./verification-evidence.md)
