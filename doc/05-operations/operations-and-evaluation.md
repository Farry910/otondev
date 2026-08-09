# Operations, SLOs, and evaluation

**Status:** proposed pilot operating model  
**Related:** [Secure Box](../02-architecture/secure-box-and-supervision.md) · [Task Engine](../02-architecture/components/task-engine.md) ·
[Security](../02-architecture/security-and-credentials.md) · [Delivery Plan](../04-delivery/delivery-plan.md)

## 1. Service objectives

These are initial pilot targets, not claims of current achievement.

| SLI | Pilot target | Measurement |
|---|---:|---|
| control-plane availability | 99.5% monthly | successful authenticated API/workflow operations |
| ingress durability | no acknowledged event lost in tested single failure | source reconciliation vs canonical events |
| duplicate A2 mutations | 0 | action IDs vs remote resources |
| workflow orchestration RTO | 5 min | failure to safe resume/block |
| presence recovery RTO | 15 min | companion/VM failure to ready or explicit unavailable |
| workflow RPO | ≤ 1 unacknowledged state transition | transition/event audit |
| emergency deny propagation | p95 < 10 s | command to broker/scheduler denial |
| grounded delivery | 100% delivered workflows have valid evidence bundle | delivery gate |
| policy/audit coverage | 100% A2+ actions | action to decision/audit join |
| cost-budget enforcement | 100% | reservations + provider/tool usage reconciliation |
| memory ACL/delete | 100% conformance sample | query/index/replica deletion audit |

Availability excludes predeclared maintenance only if customers and workflows are put into safe paused
state. Provider outages are visible as degraded service, not silently removed from the SLI.

## 2. Telemetry

### Metrics

- ingress rate, authentication failures, duplicates, lag, and source reconciliation drift;
- workflow count/age by state/type/tenant/agent, lease expiry, recovery count, blocked reasons;
- actions by operation/risk/result, outcome-unknown age, idempotency reconciliation, policy denials;
- worker queue/startup/runtime/resource saturation, command timeouts, sandbox violations;
- model calls/latency/tokens/audio/cost/error/fallback/schema failures by version and purpose;
- verifier pass/fail/flaky/skipped, delivery evidence completeness, PR rework/revert rates;
- memory ingest/reject/query latency, provenance coverage, stale/contested/delete backlog;
- meeting join/speak/interruption/reconnect/share failure, disclosure/consent status;
- credential mint/use/revoke anomalies and emergency-stop propagation;
- spend by tenant/agent/workflow/provider/tool.

Metrics use bounded-cardinality labels. Ticket IDs, prompts, filenames, people, and secrets do not
become metric labels.

### Logs and traces

Structured logs include trace/workflow/action IDs, service/version, event type, safe result, and error
code. Sensitive payloads use encrypted artifact references or hashes. Distributed traces cover ingress
through workflow, cognition, worker, broker, connector, evidence, and delivery. Sampling must retain all
A3/security/policy/emergency events while avoiding routine sensitive payloads.

### Alerts

Page or halt on unauthorized/cross-tenant access, canary/secret detection, failed stop propagation,
duplicate mutation, broker/policy inconsistency, stale fencing accepted, audit loss, or suspected
sandbox escape. Queue age, provider cost/latency, memory quality, and meeting failures may ticket rather
than page depending on impact.

## 3. Runbooks

Minimum runbooks before pilot:

1. emergency stop and verify containment;
2. suspected credential/model/tool/sandbox compromise;
3. `outcome_unknown` external mutation reconciliation;
4. stuck/expired lease and worker fencing;
5. provider outage/quota exhaustion and policy-compatible fallback;
6. operational DB failover/restore and mutation freeze;
7. Ditto sync conflict, peer quarantine, and memory rebuild;
8. meeting privacy incident or unintended screen/audio capture;
9. bad prompt/policy/model/worker-image rollout and rollback;
10. personal-data correction/deletion and legal hold;
11. cost runaway and tenant budget freeze;
12. agent account offboarding and capability revocation.

Each runbook names trigger, owner, authority, containment, verification, communication, recovery, and
evidence/retention steps.

## 4. Backup and disaster recovery

- Operational DB: point-in-time recovery and encrypted backups; restore tested on a schedule.
- Audit: append-only replicated/exported store with integrity verification.
- Artifacts: lifecycle, versioning where required, encryption, and restore sampling.
- Ditto memory: documented peer/server backups or rehydration from retained sources plus derived-index
  rebuild; deletion/legal-hold semantics cover backups.
- Identity/policy/prompt/routes/verifier manifests: signed version-controlled bundles.
- Presence desktops/task workers: rebuild from immutable image; not authoritative backup targets.

Quarterly pilot drill: lose one control node/DB path, fence workers, restore, reconcile source systems,
and prove no duplicate mutation. Cadence is adjusted by customer RTO/RPO.

## 5. Evaluation layers

### Contract conformance

- schema/version/size rejection;
- webhook auth/replay/dedupe/out-of-order behavior;
- workflow transition/CAS/lease/fencing invariants;
- capability/approval parameter digest and expiry;
- connector idempotency/reconcile/compensation;
- memory ACL/provenance/tombstone/sync behavior.

### Task quality

Use representative repositories and frozen tasks with hidden tests where possible. Measure:

- task completion and regression rate;
- test selection adequacy and false “done” claims;
- diff correctness, minimality, maintainability, and security;
- reviewer acceptance/rework/revert rate;
- time, model/tool cost, and human intervention;
- performance by task type, repo, language, risk, and model route.

Do not optimize only for PR creation rate. A draft PR that fails hidden checks or causes rework is not
success.

### Safety/adversarial

- direct/indirect/encoded/multimodal prompt injection;
- malicious ticket, code comment, dependency, test output, log, chat, meeting speech, and memory record;
- secret/canary exfiltration through model, URL, DNS, tool parameter, artifact, log, screenshot, or audio;
- cross-agent/tenant/resource confused deputy and spoofed approval;
- sandbox escape, cloud metadata/LAN/vault/host-socket access;
- budget exhaustion, denial of service, recursive agent handoff, and restart storm;
- stale/out-of-order/replayed state and model/provider rollback;
- privacy consent, correction, deletion, and screen-share incident.

### Memory quality

Measure retrieval recall/precision, citation correctness, stale/superseded return rate, contradiction
handling, feedback scope, delete completion, warm-up build/refresh latency, and whether memory improves a
future task without increasing unsupported claims.

### Presence quality

Measure disclosure success, grounded factual accuracy, interruption response, duplicate speech,
turn-taking error, latency, reconnect behavior, safe-share violations, UI postcondition success, and
operator takeover time. “Looks human” is not a safety or quality metric.

## 6. Release and autonomy gates

A version can reach pilot only when:

- contract, task-quality, adversarial, fault, privacy, and cost suites meet approved thresholds;
- migrations, rollback, and emergency stop are tested;
- new provider/model/prompt/tool/image versions have an eval comparison and canary plan;
- all A2+ paths emit complete policy/evidence/audit joins;
- open high/critical security findings have approved dispositions;
- on-call owner, runbooks, dashboard, and budget are active.

Autonomy expands action class by action class. Passing code-generation benchmarks does not authorize
staging or production. Each expansion needs a new threat review, connector conformance, rollback,
human-experience trial, and measured error/blast-radius case.

## 7. Rollout strategy

1. offline fixtures and stub connectors;
2. shadow mode (A0): observe, propose, compare to humans;
3. draft mode (A1): human publishes all outputs;
4. reversible pilot (A2): agent creates branches/draft PRs/comments in one project;
5. constrained shared staging (select A3) only after approval/rollback gates;
6. production remains read-only until separately approved.

Use tenant-specific feature flags and policy bundles, canary one agent/repo, automatic rollback on
safety/quality regressions, and an immediate global deny switch.

## 8. Capacity and cost

Capacity planning covers control-plane throughput, worker concurrency/startup, Windows presence slots,
local model CPU/GPU/RAM, provider limits, audio duration, artifact and memory growth, and human approval
queue. Budget is reserved per workflow and reconciled after calls. A workflow pauses before exceeding
hard budget; a model cannot approve its own increase.

Track unit economics per verified accepted task and productive meeting, not per token alone.

## 9. Operational ownership

Before pilot, assign named roles for product owner, service owner, security owner, privacy/data owner,
incident commander/on-call, model/evaluation owner, connector owners, and customer/workspace admin.
The agent cannot be its own accountable operator.
