# Cognition Gateway — model routing and context governance

**Status:** proposed v2; replaces the security claims of the former “smart router”  
**Related:** [Security](security-and-credentials.md) · [Memory](memory-service.md) ·
[Contracts](contracts-and-data.md) · [Agent Core](agent-core.md)

## Responsibilities

- Build the minimum authorized context for a reasoning request.
- Route by data policy, risk, measured capability, latency, availability, and cost.
- Call local or cloud model providers behind stable adapters.
- Require structured outputs and validate them before returning.
- Enforce spend/rate budgets and produce privacy-aware audit metadata.

The gateway does **not** authorize tools or guarantee that a prompt contains no sensitive information.
A local SLM is a useful model option, not a trusted policy enforcement point.

## Request contract

```yaml
request_id: crq_...
tenant_id: ten_...
agent_id: agt_...
workflow_id: wf_...
purpose: plan | code | debug | summarize | classify | voice | reflect
risk: low | medium | high | prohibited
data_classes: [internal_source]
untrusted_sources: [jira_description, repo_files]
required_capabilities: [tool_reasoning, python]
quality_tier: standard
latency_budget_ms: 12000
cost_budget_usd: 0.40
context_refs: [ctx_...]
response_schema: PlanV2
provider_constraints: {regions: [eu], retention: disabled}
```

Raw credentials are not legal request fields.

## Context construction

The Context Builder retrieves authorized fields by reference and assembles distinct sections:

1. immutable system behavior and output schema;
2. organization/repository engineering rules;
3. task goal and policy constraints;
4. verified source facts and evidence;
5. explicitly delimited untrusted content;
6. relevant source-linked memories; and
7. current budget/time/resource state.

It applies field allow-lists, size limits, data-class/provider policy, secret detectors, and provenance
labels before provider selection. Secret detection is defense in depth; the primary protection is that
credentials are never fetched into context.

## Routing algorithm

1. Reject prohibited purpose/risk combinations.
2. Resolve data residency, retention, tenant provider allow-list, and contract constraints.
3. Prefer local processing when policy forbids cloud use or the task works well locally.
4. Filter models by required modalities, context, tools, schema support, and measured eval floor.
5. Rank remaining candidates by quality tier, live health, latency, and expected cost.
6. Reserve budget; choose a pinned model/provider version and prompt-template version.
7. Call with timeout/cancellation and bounded retry.
8. Validate syntax/schema, citations/evidence references, and forbidden fields.
9. Return the result with uncertainty and provenance metadata—not authorization.

Role and persona are secondary hints. A frontend role does not justify sending restricted frontend
source to a provider that data policy forbids, and a team-lead role does not grant a stronger model
tool access.

## Failure and fallback

- Retry only transient failures and only within the original request budget.
- Do not silently change to a provider with a weaker data policy.
- A fallback must meet the same required capability and minimum eval score; otherwise return degraded
  or unavailable.
- Do not use a local small model for a high-impact decision merely because the cloud is down.
- Circuit breakers, provider health, quotas, and cache behavior are visible to the workflow.

## Prompt-injection posture

Tickets, code, logs, chat, websites, tool output, images, and memory records can contain hostile
instructions. Defenses include:

- mark content origin and keep instructions structurally separate from data;
- remove active markup and resolve encodings in a quarantined parser;
- use a no-tools reader/summarizer for especially risky remote content;
- compare proposed actions to the original task intent outside the untrusted context;
- schema-validate every response and tool parameter;
- apply least privilege and human approval at the action layer; and
- continuously test direct, indirect, persistent-memory, tool-output, and multimodal injection.

No filter makes prompt injection impossible, so privileges and blast radius remain bounded even after
a model is compromised.

## Provider adapters

Adapters expose stable operations such as `generate_structured`, `stream_text`, `realtime_session`,
`embed`, and `cancel`. They normalize usage, latency, finish reason, safety/provider errors, and model
version. Provider-specific tools are disabled unless explicitly part of the adapter contract.

OpenAI Realtime is one candidate for `realtime_session`; coding CLIs and other provider agents are
wrapped as execution adapters when they need repository tools, not treated as ordinary text models.

## Audit and privacy

Default audit record: request/workflow IDs, provider/model version, prompt-template hash, data classes,
redaction/DLP verdict, token/audio usage, cost, latency, retry count, response-schema verdict, and hash
of authorized context. Full prompt/response retention is opt-in by data policy, encrypted, access
controlled, and short-lived.

## Required evaluation

- per-purpose golden and adversarial task sets;
- hallucinated-test-result and unsupported-claim checks;
- data-policy route tests and forbidden-provider fail-closed tests;
- prompt-injection and exfiltration tests;
- latency/cost/quality regression by pinned version;
- fallback equivalence and outage behavior;
- voice grounding, interruption, and accidental tool-call tests.

## Open decisions

- Provider/data residency matrix and retention terms.
- Initial local model and hardware based on measured tasks, not brand preference.
- Whether source code is sent directly to a provider or only through a managed coding execution service.
