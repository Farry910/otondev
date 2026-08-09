# Contracts and data model

**Status:** proposed normative v2  
**Related:** [Architecture](../first_high_level_architecture.md) · [Agent Core](agent-core.md) ·
[Security](security-and-credentials.md)

This document defines semantic contracts. JSON/YAML examples are illustrative; implementation schemas
must be versioned and generated/validated in code.

## 1. Common envelope rules

Every event, command, decision, result, and evidence record includes:

```yaml
schema: agentdev.<type>.v2
id: globally_unique_time_orderable_id
tenant_id: ten_...
agent_id: agt_...          # optional only before assignment
workflow_id: wf_...        # optional only for ingress
correlation_id: cor_...
causation_id: prior_record_id
created_at: RFC3339_UTC
producer: {service: ingress, instance: ..., version: ...}
data_classes: [internal]
integrity: {alg: sha256, digest: ...}
trace: {trace_id: ..., span_id: ...}
```

Rules:

- IDs are opaque and unique; display names are never identifiers.
- Times use UTC plus original source timestamp/timezone when relevant.
- Schemas are backward-compatible within a major version; unknown major versions fail closed.
- Payload sizes are bounded; large values use encrypted artifact references.
- Secret values are illegal in contracts. Logs redact/hide fields by schema, not only string matching.
- `tenant_id` is always part of storage keys and authorization checks.
- Integrity digests detect accidental/tampered changes; signing is used across trust boundaries where
  producer identity must be proven.

## 2. Canonical ingress event

```yaml
schema: agentdev.event.v2
id: evt_...
tenant_id: ten_acme
source:
  system: jira
  installation_id: jira_acme
  event_id: vendor_event_123
  occurred_at: 2026-07-30T08:00:02Z
  authenticated_principal: jira_cloud_app
kind: ticket.created
subject: {type: ticket, id: ENG-42, version: "10419"}
payload_ref: art_...        # immutable normalized payload
untrusted_fields: [description, comments]
dedupe_key: ten_acme:jira:jira_acme:vendor_event_123
received_at: 2026-07-30T08:00:03Z
```

Ingress acknowledges only after authentication, dedupe persistence, and durable enqueue succeed.
Duplicate events return the existing canonical event ID. Out-of-order source versions are retained but
do not silently roll state backward.

## 3. Workflow record and state machine

```yaml
schema: agentdev.workflow.v2
id: wf_...
tenant_id: ten_acme
agent_id: agt_kai
type: ticket_delivery
state: EXECUTING
state_version: 17
goal_ref: art_goal_...
source_refs: [evt_..., ticket:jira:ENG-42@10419]
definition_of_done_ref: dod_repo_api_v3
risk: medium
data_classes: [internal_source]
autonomy_required: A2
priority: 50
budget: {usd_max: 5, deadline: ..., cpu_seconds: 7200}
lease: {owner: worker_7, expires_at: ..., fencing_token: 22}
locks: [ticket:jira:ENG-42, repo:api:branch:agent/ENG-42]
attempt: 2
next_wakeup_at: null
last_checkpoint_ref: chk_...
```

### States

| State | Meaning | Allowed next states |
|---|---|---|
| RECEIVED | durable authenticated input exists | TRIAGED, REJECTED, CANCELLED |
| TRIAGED | ownership/risk/data/scope assessed | PLANNED, WAITING_INPUT, REJECTED |
| PLANNED | bounded plan and definition of done exist | WAITING_AUTH, LEASED, WAITING_INPUT |
| WAITING_AUTH | policy requires exact approval | LEASED, DENIED, CANCELLED |
| LEASED | resources and fenced worker assigned | EXECUTING, PAUSED, FAILED |
| EXECUTING | task steps running | VERIFYING, WAITING_INPUT, PAUSED, FAILED |
| VERIFYING | independent checks running | DELIVERING, EXECUTING, FAILED |
| DELIVERING | authorized external outputs publishing | DONE, WAITING_INPUT, FAILED |
| RECOVERING | reconciling an interrupted/unknown attempt | prior safe active state, WAITING_INPUT, FAILED |
| WAITING_INPUT | bounded external dependency | PLANNED, EXECUTING, CANCELLED |
| PAUSED | no new actions; resumable | RECOVERING, CANCELLED |
| BLOCKED | no automatic progress path | PLANNED, CANCELLED |
| DONE/REJECTED/DENIED/CANCELLED/FAILED | terminal | none; create a new workflow to retry terminal work |

Every transition is compare-and-set on `state_version` and records a transition event. `FAILED` is
terminal for one workflow attempt definition; an operator/system retry creates a linked workflow or a
new attempt only when the original action reconciliation is complete.

From any non-terminal state, a policy revocation or operator command may request `PAUSED` or
`CANCELLED`; the transition completes only after active capabilities are denied, the current lease is
fenced or safely checkpointed, and the state-specific containment rule succeeds. `BLOCKED` is used
when progress has no known automatic or awaited-input path.

## 4. Plan and command

```yaml
schema: agentdev.plan.v2
id: plan_...
workflow_id: wf_...
goal_digest: ...
assumptions: [...]
unknowns: [...]
expected_files: [src/auth.py, tests/test_auth.py]
expected_external_effects: [git.create_branch, git.open_draft_pr, jira.comment]
steps:
  - step_id: s1
    purpose: reproduce
    action_class: worker.command
    risk: low
    success_condition: failing_test_captured
definition_of_done_ref: dod_repo_api_v3
rollback_or_compensation: {before_publish: destroy_workspace, after_publish: close_draft_pr}
limits: {files_changed: 12, commands: 40, wall_seconds: 7200}
```

An `ExecutionCommand` references a plan step, lease/fencing token, policy decision, capability handles,
workspace/base SHA, timeout, resource limits, cancellation token, and response schema. The worker
rejects commands with a stale fencing token, expired capability, changed plan digest, or missing policy.

## 5. Policy decision and approval

```yaml
schema: agentdev.policy_decision.v2
id: pdec_...
subject: {agent_id: agt_kai, workload_id: worker_7}
action: git.open_draft_pr
resource: repo:team/api
environment: nonprod
parameter_digest: sha256:...
workflow_id: wf_...
plan_id: plan_...
autonomy_level: A2
data_classes: [internal_source]
decision: allow             # allow | deny | require_approval
policy_bundle: engineering-pilot-v2@sha256:...
constraints: {branch_prefix: agent/, max_uses: 1}
expires_at: ...
reason_codes: [A2_ALLOWED_REPO, DRAFT_ONLY]
```

```yaml
schema: agentdev.approval.v2
id: apr_...
approver: {human_id: usr_..., authn_strength: mfa}
decision_request_id: drq_...
action: staging.deploy
resource: service:api
environment: staging
parameter_digest: sha256:...
plan_digest: sha256:...
expires_at: ...
max_uses: 1
status: active              # active | consumed | expired | revoked
signature: ...
```

Free-form “yes,” an emoji, a ticket label, model output, or chat text is not an approval unless a
tenant policy adapter authenticates it and creates this exact bound record.

## 6. Capability

```yaml
schema: agentdev.capability.v2
id: cap_...
subject: {workload_id: worker_7, agent_id: agt_kai}
workflow_id: wf_...
action_id: act_...
operation: jira.add_comment
resource: ticket:jira:ENG-42
constraints:
  body_digest: sha256:...
  max_uses: 1
lease_fencing_token: 22
issued_at: ...
expires_at: ...
revocation_epoch: 54
broker_signature: ...
```

The capability is an authorization token/handle, not the target-system secret. The connector checks
signature, expiry, use count, fencing token, revocation epoch, parameter digest, and target resource.

## 7. External action and idempotency

```yaml
schema: agentdev.action.v2
id: act_...
workflow_id: wf_...
adapter: github
operation: pull_request.create_draft
resource: repo:team/api
parameter_digest: sha256:...
idempotency_key: ten_acme:act_...
state: prepared             # prepared | sent | succeeded | failed | outcome_unknown
attempts: 0
policy_decision_id: pdec_...
approval_id: null
capability_id: cap_...
remote_ref: null
last_error: null
```

Adapters must implement `execute`, `lookup/reconcile`, and where possible `compensate`. An ambiguous
timeout sets `outcome_unknown`; automatic retry is forbidden until reconciliation says absent or the
provider guarantees the same idempotency key.

## 8. Cognition request/result

The request shape is defined in [cognition-router.md](cognition-router.md). A result includes provider,
model/version, prompt-template version/hash, authorized context digest, structured content, schema
verdict, usage/cost/latency, uncertainty, citations/evidence refs, and completion/failure reason.
It never contains a trusted authorization decision.

## 9. Memory record

```yaml
schema: agentdev.memory.v2
id: mem_...
tenant_id: ten_acme
owner_scope: {type: agent, id: agt_kai}
record_type: fact
source_or_derived: derived
claim: "CI test X is known to flake on Windows image 4"
scope: {repo: team/api, platform: windows-image-4}
provenance:
  source_refs: [run:ci:991, review:github:778]
  derivation: {model: ..., template: reflection-v3}
confidence: 0.78
status: contested        # active | contested | superseded | tombstoned
observed_at: ...
valid_from: ...
valid_until: null
data_class: internal
acl: {read: [team-x], publish: [maintainers]}
retention: {expires_at: ..., legal_hold: false}
supersedes: null
integrity: {version: 4, digest: ...}
```

The context builder treats `claim` as data and uses provenance/status, not repetition count, for
authority.

## 10. Evidence bundle

```yaml
schema: agentdev.evidence.v2
id: evb_...
workflow_id: wf_...
task_source: ticket:jira:ENG-42@10419
repository: {url: ..., base_sha: ..., head_sha: ..., diff_digest: ...}
environment: {worker_image: image@sha256:..., toolchain: [...]}
checks:
  - {name: unit, command_digest: ..., exit_code: 0, log_ref: art_..., log_digest: ...}
verifier: {version: verifier-v3, verdict: pass, limitations: []}
policy_refs: [pdec_...]
approval_refs: []
action_refs: [act_...]
artifacts: [{ref: art_..., kind: junit, digest: ..., retention: ...}]
created_at: ...
signature: ...
```

An evidence bundle is immutable; corrections create a superseding bundle.

## 11. Error contract

Errors contain stable `code`, retryability, safe public message, internal diagnostic reference, owning
component, and recommended state transition. Never embed raw provider responses or secret-bearing
commands in the public message. Examples:

- `POLICY_DENIED`
- `APPROVAL_EXPIRED`
- `LEASE_FENCED`
- `ACTION_OUTCOME_UNKNOWN`
- `DATA_PROVIDER_FORBIDDEN`
- `VERIFY_FAILED`
- `PRESENCE_CONSENT_REQUIRED`
- `MEMORY_PROVENANCE_MISSING`

## 12. Versioning and migrations

- Persist producer and schema versions on every durable record.
- Readers support current and one prior major version during rolling upgrade or use explicit migrators.
- Policy, prompt, model route, worker image, verifier, persona, and memory derivation are independently
  versioned and included in evidence/audit.
- Destructive schema/retention migrations require backup, dry-run counts, and rollback plan.
- Derived memories may be re-derived, but sources and old evidence remain available subject to policy.
