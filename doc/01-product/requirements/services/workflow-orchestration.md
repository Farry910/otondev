# Workflow and task orchestration service requirements

**Code:** WFE  
**Owns:** authoritative work state, claims, scheduling, resource locks, and checkpoints  
**Direct dependencies:** IDN, POL, AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Own the lifecycle of work and coordinate concurrency across agents and workers.

## Requirements

- **WFE-01:** Work states MUST be received, triaged, awaiting-input, planned, awaiting-approval,
  ready, claimed, executing, verifying, delivering, completed, blocked, failed, cancelled, or
  superseded.
- **WFE-02:** Validate actor, prior state, required evidence, and policy on each transition.
- **WFE-03:** Claims MUST be atomic, leased, renewable, and fenced.
- **WFE-04:** Scheduling considers role fit, priority, due date, dependencies, ownership, conflicts,
  resource locks, concurrency, and budget.
- **WFE-05:** Parallel subtasks require non-conflicting ownership and an explicit join condition.
- **WFE-06:** Prevent concurrent mutation of the same ticket, branch, environment, or exclusive
  resource.
- **WFE-07:** Store a plan, definition of done, mutations, verification, and risk before non-trivial
  execution.
- **WFE-08:** Cancellation and revocation propagate to workers and fence later delivery.
- **WFE-09:** Retries distinguish reads, idempotent writes, uncertain writes, and non-repeatable acts.
- **WFE-10:** Blocked work identifies the exact missing human action or dependency.

## Acceptance

Competing workers cannot double-claim; cancellation prevents delivery; recovery resumes only from
valid checkpoints.

## Related requirements

- [Agent core and planner](./agent-core-planner.md)
- [Policy, risk, and approval](./policy-risk-approval.md)
- [Supervisor and lifecycle](./supervisor-lifecycle.md)
- [Platform infrastructure dependencies](../dependencies/platform-infrastructure.md)
