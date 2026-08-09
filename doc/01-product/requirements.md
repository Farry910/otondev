# Product requirements

**Status:** proposed baseline  
**Related:** [Architecture](../02-architecture/architecture-v2.md) · [Review](../06-decisions/review-findings.md)

## 1. Product statement

Agent Dev is a transparently identified AI software-engineering teammate. It maintains a stable role
and memory, discovers work from team systems, proposes and performs policy-authorized engineering
actions, produces verifiable evidence, communicates through chat and meetings, and learns from
approved outcomes.

## 2. Stakeholders

- engineering team members collaborating with the agent;
- repository, service, security, and data owners;
- incident commander/on-call operator;
- workspace administrators and auditors;
- people whose speech, chat, code, or profile information may enter memory.

The agent is an actor but not the accountable legal or operational owner. A human or organization
must own every deployed agent, policy, and credential scope.

## 3. Autonomy requirements

The platform MUST label each action A0–A4 as defined in the architecture. Policy MAY grant a maximum
level per agent, but the effective permission is the minimum across agent, repository, environment,
data class, current incident mode, and action type.

- First release: A0–A2 only.
- Shared staging changes (A3): exact action approval, expiry, rollback plan, and verifier required.
- Production (A4): read-only observation and proposal only in the pilot.
- An approval MUST bind actor, action name, normalized parameters digest, resource, environment,
  expiry, and approver. Editing any bound field invalidates it.

## 4. Functional requirements

### FR-1 Identity and transparency

- The agent MUST have a stable `agent_id`, display name, role, owner, policy set, and versioned persona.
- It MUST identify itself as automated in profile and at the start of a meeting unless the platform
  already displays an equivalent bot indicator.
- Persona MAY shape communication. It MUST NOT override policy or fabricate experiences, emotions,
  test results, or human identity.

### FR-2 Work discovery and selection

- Ingress MUST authenticate events, normalize them, deduplicate them, and retain source identifiers.
- Work selection MUST obey skills, priority, ownership, conflict-of-interest, concurrency, and budget.
- Claiming work MUST use an atomic transition/lease to prevent two agents doing the same task.

### FR-3 Planning and authorization

- A non-trivial task MUST have a bounded plan, definition of done, expected mutations, test strategy,
  and risk/data classification before execution.
- Policy decisions MUST be deterministic and logged. Model output MUST NOT be the sole policy input.
- Denied or uncertain actions MUST become a bounded question, safe alternative, or blocked state.

### FR-4 Execution

- Repository work MUST run in a task-isolated workspace with resource and network limits.
- External mutations MUST use typed adapters and idempotency keys.
- The task process MUST NOT receive general-purpose long-lived secrets.
- The platform MUST support cancellation, timeout, checkpoint, and fenced recovery.

### FR-5 Verification and delivery

- Verification MUST run from an explicit repository definition of done.
- Delivery MUST cite immutable code and evidence references and state unverified limitations.
- The agent MUST NOT approve or merge its own work. A second agent can provide analysis, but a human
  remains the required approver for protected branches in the pilot.

### FR-6 Collaboration

- The agent MAY comment, request input, hand off, and review within granted A1/A2 policies.
- Inter-agent messages MUST be authenticated, attributable, and treated as untrusted data—not policy.
- Ticket, branch, and shared-resource conflicts MUST be resolved through the workflow engine.

### FR-7 Meetings and presentation

- Joining, recording, transcription, and screen sharing MUST satisfy calendar/meeting policy and
  participant disclosure/consent rules.
- The agent MUST support mute, interruption, leave, and an operator takeover.
- Screen sharing MUST pass a sensitive-content and target-window preflight.

### FR-8 Memory and learning

- Stored records MUST include origin, time, data class, ACL, retention, and provenance.
- Derived memories MUST link to source records, carry confidence, and support supersession.
- Feedback MUST not become a global rule until its author/scope is known or it is approved.
- Correction and deletion MUST propagate to indexes, warm sets, summaries, and shared projections.

### FR-9 Credentials and tools

- Secret values MUST be retrieved only by a broker and injected only into the minimum trusted adapter.
- Tokens SHOULD be short-lived and action-scoped; every mint/use MUST be audited.
- Tool parameters MUST be schema-validated and matched to original task intent and policy.

### FR-10 Operations

- Operators MUST be able to pause an agent, deny new leases/capabilities, cancel a task, revoke tokens,
  and quarantine a worker.
- The system MUST expose health, queue age, failure rate, action rate, spend, policy denials, and
  recovery status without exposing secret contents.

## 5. Quality requirements

| ID | Requirement | Pilot target or gate |
|---|---|---|
| QR-1 Safety | no unauthorized external mutation | zero in conformance/adversarial suite |
| QR-2 Idempotency | duplicate/replayed events do not duplicate mutations | zero duplicates in fault suite |
| QR-3 Grounding | completion claims cite executable evidence | 100% of delivered tasks |
| QR-4 Recoverability | resume from process/worker loss | RTO/RPO targets in operations doc |
| QR-5 Privacy | retained data follows class/consent/TTL/delete | 100% sampled compliance |
| QR-6 Transparency | bot identity and limitations are clear | meeting/chat acceptance test |
| QR-7 Auditability | action can be reconstructed from metadata/evidence | 100% of A2+ actions |
| QR-8 Cost control | hard task/provider budgets enforced | no budget overrun without approval |
| QR-9 Quality | task-specific tests and reviewer rubric pass | baseline before autonomy expansion |
| QR-10 Accessibility | presentation uses semantic targets and safe fallbacks | target-platform test matrix |

Targets are proposals until the pilot owner approves them.

## 6. First vertical-slice acceptance

Given one authorized repository and one synthetic ticket, the system must:

1. authenticate and dedupe the event;
2. form a bounded plan and policy decision;
3. atomically claim the work;
4. create an isolated branch/workspace without exposing a general credential;
5. implement and run the repository's deterministic checks;
6. open one draft PR and update the ticket once;
7. publish a complete evidence bundle;
8. recover correctly from a crash before and during delivery; and
9. stop safely when the operator revokes capability.

Meeting voice, fleet collaboration, production incidents, and broad memory ingestion are not part of
this first gate.
