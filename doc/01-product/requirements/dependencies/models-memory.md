# Model and memory dependency requirements

**Parent:** [Agent Dev requirements](../../requirements.md)

## Ollama and local SLM

- **MMD-01:** Ollama and the approved small language model are mandatory for demo local
  pre-reasoning.
- **MMD-02:** The server MUST bind only to the approved local boundary and require authenticated
  service access.
- **MMD-03:** The model name, weights digest, runtime version, context limit, and resource limits MUST
  be pinned and auditable.
- **MMD-04:** Local output remains untrusted model output and cannot grant policy or verify high-risk
  actions.
- **MMD-05:** When the model is unavailable or insufficient, the gateway MUST use an authorized
  fallback or return a bounded question or blocked state.

## Cloud coding and reasoning provider

- **MMD-06:** At least one cloud coding/reasoning provider is mandatory for the demo.
- **MMD-07:** Provider qualification MUST define permitted data classes, regions, retention, training
  use, model versions, context and tool limits, quotas, and cost budgets.
- **MMD-08:** Fallback providers are disabled until separately qualified and authorized.
- **MMD-09:** Provider outage, rate limit, or budget exhaustion MUST not cause privacy downgrade or
  unbounded retries.
- **MMD-10:** The provider adapter MUST preserve cancellation, structured outputs, usage accounting,
  and result attribution.

## OpenAI Realtime

- **MMD-11:** OpenAI Realtime is the intended initial RTC provider for the meeting demo.
- **MMD-12:** Its adapter MUST support interruption, cancellation, mute, session termination, usage
  budgets, and transcript policy.
- **MMD-13:** Provider failure MUST degrade to mute, text, or meeting exit according to policy.
- **MMD-14:** Audio and text sent to RTC MUST pass data-destination and participant-consent checks.

## Ditto memory candidate

- **MMD-15:** The exact product meant by “Ditto,” its edition, license, API, and hosting model are TBD.
- **MMD-16:** A qualification spike MUST verify ACL filtering, provenance, versioning, conflict
  handling, retention, correction, deletion propagation, backup, and recovery.
- **MMD-17:** Memory consumers MUST use the MEM-owned backend contract, never a Ditto-specific API.
- **MMD-18:** An alternate backend and export format MUST exist before Ditto becomes a hard production
  dependency.

## Consumers

- [Cognition and model gateway](../services/cognition-model-gateway.md)
- [Memory and learning](../services/memory-learning.md)
- [Presence and real-time communication](../services/presence-realtime.md)
