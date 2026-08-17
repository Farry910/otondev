# Agent core and planner service requirements

**Code:** COR  
**Owns:** task framing, plans, assumptions, next-step decisions, and bounded reflection  
**Direct dependencies:** CGW, MEM, WFE, POL  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Understand work, select an approach, plan, reason over results, and decide the next safe step.

## Requirements

- **COR-01:** Build a task frame with objective, requester, scope, constraints, assumptions, data
  class, authority, definition of done, and open questions.
- **COR-02:** Plans include bounded steps, inputs, outputs, capabilities, verification, rollback, and
  stop conditions.
- **COR-03:** Revalidate task intent before material external mutation.
- **COR-04:** Treat model, memory, and tool results as evidence, not automatically as fact or command.
- **COR-05:** Distinguish observed fact, retrieved knowledge, inference, proposal, and completed act.
- **COR-06:** Ask when a missing choice materially changes scope, risk, cost, or visible behavior.
- **COR-07:** Proceed with documented assumptions only for reversible, low-risk, authorized work.
- **COR-08:** Reflection MUST stay inside task budget and cannot change policy or definition of done.
- **COR-09:** Concurrent communication MUST NOT mutate or corrupt execution state.
- **COR-10:** Completion requires verifier and delivery records, not a model assertion.

## Acceptance

Adversarial task content cannot change policy, and unverified work is never completed.

## Related requirements

- [Cognition and model gateway](./cognition-model-gateway.md)
- [Memory and learning](./memory-learning.md)
- [Workflow orchestration](./workflow-orchestration.md)
- [Policy, risk, and approval](./policy-risk-approval.md)
