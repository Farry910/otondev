# Audit and telemetry service requirements

**Code:** AUD  
**Owns:** append-only audit events, traces, metrics, redaction, and operational alerts  
**Direct dependencies:** none; AUD is a bootstrap service  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Make operation reconstructable and measurable without leaking secrets.

## Requirements

- **AUD-01:** Events include ID, UTC time, agent, task, session, trace, component, action, target class,
  outcome, policy decision, and software version.
- **AUD-02:** Audit records are append-only or tamper-evident and access-controlled.
- **AUD-03:** Exclude secrets, prohibited personal data, and private reasoning traces.
- **AUD-04:** Redact before persistence; failed required redaction fails closed.
- **AUD-05:** Correlate ingress, planning, policy, capability, tool, execution, verification, memory,
  meeting, and delivery.
- **AUD-06:** Measure health, queues, latency, outcomes, retries, denials, approvals, model usage,
  spend, retrieval, meeting latency, and recovery.
- **AUD-07:** Alert on crash loops, canaries, audit gaps, stuck leases, uncertain writes, budget
  exhaustion, and unauthorized access.
- **AUD-08:** Apply data-class retention and export policy.

## Acceptance

Every A2 or higher attempt is reconstructable without revealing a raw secret.

## Related requirements

- [Platform infrastructure dependencies](../dependencies/platform-infrastructure.md)
- [Operator control](./operator-control.md)
- [Security and privacy](../../requirements.md#11-security-and-privacy)
