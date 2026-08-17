# Cognition and model gateway requirements

**Code:** CGW  
**Owns:** model routing, prompt/context construction, provider budgets, and fallback  
**Direct dependencies:** IDN, POL, MEM, AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Route inference among local pre-reasoning, cloud coding/reasoning, and real-time models.

## Requirements

- **CGW-01:** All model access MUST use provider-neutral gateway contracts.
- **CGW-02:** Routing considers task, role, data class, allowed destination, capability, context,
  latency, availability, quality, and budget.
- **CGW-03:** Ollama pre-reasoning SHOULD handle suitable sensitive classification, routing, compact
  planning, and redaction checks.
- **CGW-04:** A local model MUST NOT authorize policy or solely verify high-risk actions.
- **CGW-05:** Raw credentials and prohibited data MUST NOT be sent to models.
- **CGW-06:** Context uses least data, preserves sources, and enforces requester access.
- **CGW-07:** Calls require cancellation, timeout, rate limits, retry rules, and token/cost budgets.
- **CGW-08:** Provider fallback repeats data and authority checks and MUST NOT weaken privacy.
- **CGW-09:** Schema-validate structured output before use.
- **CGW-10:** Audit provider/model versions, routing, usage, latency, and result hashes.
- **CGW-11:** Provider replacement MUST NOT change workflow, policy, or tool contracts.

## Acceptance

Tests prove local-only routing for prohibited cloud data, budget enforcement, safe provider failure,
and malformed-output rejection.

## Related requirements

- [Model and memory dependencies](../dependencies/models-memory.md)
- [Policy, risk, and approval](./policy-risk-approval.md)
- [Memory and learning](./memory-learning.md)
- [Audit and telemetry](./audit-telemetry.md)
