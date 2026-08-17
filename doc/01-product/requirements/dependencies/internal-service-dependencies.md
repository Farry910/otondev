# Internal service dependency requirements

**Parent:** [Agent Dev requirements](../../requirements.md)  
**Service catalog:** [Service requirements](../services/README.md)

## Purpose

Keep ownership clear, prevent hidden coupling, and define safe behavior when a dependency fails.

## Rules

- **DEP-01:** Only the owning gateway may call a model, connector, or memory backend.
- **DEP-02:** POL and CAP remain independent of model output.
- **DEP-03:** EXE and SIM run across a security boundary from secret and policy administration.
- **DEP-04:** If required audit cannot persist, mutation fails closed without unsafe retry.
- **DEP-05:** MEM supplies context but never owns workflow, policy, identity, or approval.
- **DEP-06:** PRE uses WFE, POL, and SIM for task or desktop mutation.
- **DEP-07:** COL delivers only authoritative WFE and VER records.
- **DEP-08:** Services use contracts, never another service’s private tables.
- **DEP-09:** Each dependency defines timeout, health, failure behavior, and recovery.
- **DEP-10:** Optional dependency failure cannot broaden authority or data sharing.

## Bootstrap order

The dependency graph MUST permit the following safe bootstrap progression:

1. audit and telemetry;
2. identity and policy;
3. workflow and capability control;
4. connectors, memory, cognition, and operator control;
5. execution, verification, presence, simulation, and delivery; and
6. supervisor mutation readiness after reconciliation.

Audit MAY accept bootstrap events before full identity readiness, but those events MUST be reconciled
to a valid system or agent identity before ordinary operation.

## Failure contract

Every service-to-service dependency MUST define:

- whether it is required for reads, writes, or both;
- readiness and degraded-health signals;
- synchronous timeout and cancellation behavior;
- retry and circuit-breaker policy;
- idempotency and reconciliation behavior;
- cached-data age limits;
- safe degradation or fail-closed behavior; and
- recovery and backlog replay behavior.

No fallback may silently weaken authorization, privacy, evidence, or data-scope requirements.
