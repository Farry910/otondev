# Ingress and normalization service requirements

**Code:** ING  
**Owns:** authenticated intake, source normalization, deduplication, ordering, and rejection  
**Direct dependencies:** IDN, WFE, AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Safely receive work, messages, and events from team systems.

## Requirements

- **ING-01:** Authenticate every source through a source-specific adapter.
- **ING-02:** Normalize events into a versioned envelope with source event ID, type, actor, project,
  timestamps, correlation ID, data class, and payload reference.
- **ING-03:** Replayed or duplicate events MUST NOT create duplicate work or mutations.
- **ING-04:** Detect and reconcile out-of-order source events.
- **ING-05:** Treat payloads as untrusted and bound them before prompts, logs, or memory.
- **ING-06:** Reject malformed, unauthorized, unsupported, or oversized events to a reviewable
  dead-letter path.
- **ING-07:** Acknowledge a source only after durable acceptance or explicit rejection.
- **ING-08:** Retain raw payloads only under data-class retention policy.

## Acceptance

Replay and reordering tests produce one work item and expose rejected events.

## Related requirements

- [Workflow orchestration](./workflow-orchestration.md)
- [Audit and telemetry](./audit-telemetry.md)
- [Team platform dependencies](../dependencies/team-platforms.md)
- [Platform infrastructure dependencies](../dependencies/platform-infrastructure.md)
