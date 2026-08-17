# Capability and credential broker requirements

**Code:** CAP  
**Owns:** secret retrieval, short-lived credentials, capability leases, and revocation  
**Direct dependencies:** POL, AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Keep secrets out of models and general task processes while granting narrowly scoped capabilities.

## Requirements

- **CAP-01:** Store secrets only in an approved secrets manager.
- **CAP-02:** Only the broker and minimum trusted adapter may retrieve a secret value.
- **CAP-03:** Prefer short-lived, action-scoped tokens over long-lived credentials.
- **CAP-04:** Bind leases to agent, task, operation, resource, environment, expiry, and policy.
- **CAP-05:** Give task processes handles or trusted proxies, not reusable general credentials.
- **CAP-06:** Audit mint, use, denial, expiry, and revocation without logging values.
- **CAP-07:** Support immediate revocation by agent, task, connector, or credential scope.
- **CAP-08:** Scan prompts, logs, memory, evidence, messages, and model requests for secrets.
- **CAP-09:** Rotation and revocation MUST NOT require rebuilding the agent.

## Acceptance

Canary secrets cannot reach a model, child process, log, memory, evidence, or message.

## Related requirements

- [Policy, risk, and approval](./policy-risk-approval.md)
- [Platform infrastructure dependencies](../dependencies/platform-infrastructure.md)
- [Secure workspace and task executor](./secure-task-executor.md)
