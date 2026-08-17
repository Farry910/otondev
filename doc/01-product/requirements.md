# Agent Dev product requirements

**Status:** working baseline for product review

**Version:** 0.3

**Last updated:** 2026-08-16

**Primary source:** [primary_messy_design.md](./primary_messy_design.md)

## 1. How this specification is organized

This file is the master specification for shared product behavior. Detailed normative requirements
are divided by ownership:

- [Service requirements](./requirements/services/README.md) — one file for each of the 17 logical
  services.
- [Dependency requirements](./requirements/dependencies/README.md) — internal service rules plus
  runtime, model, memory, team-platform, and infrastructure dependencies.

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative. A requirement
marked **TBD** is not implementation-ready until its decision in Section 15 is resolved.

## 2. Product definition

Agent Dev is a transparently identified AI software-engineering teammate. Each deployed agent has a
stable identity, engineering role, authorized tools, durable knowledge, and continuous work
lifecycle. It can discover and deliver engineering work, collaborate with people and other agents,
participate in live meetings, demonstrate work through a real desktop, and learn from approved
outcomes.

### 2.1 Meaning of continuity and agency

The source design says that the agent is “alive,” decides for itself, and “must never die.” For an
implementable and honest product, this means:

- the agent maintains a continuous identity, work queue, memory, and presence across process restarts;
- it selects and plans work within goals, policies, budgets, and granted authority instead of blindly
  executing every incoming instruction;
- it may initiate safe, authorized actions and ask bounded questions when information is missing;
- it is always disclosed as automated and MUST NOT claim to be human, conscious, or to have
  experiences it did not have; and
- no process is literally immortal. Durable state, supervision, restart, and recovery provide
  continuity.

Services are logical ownership boundaries, not a requirement for one microservice per file. The demo
MAY co-locate services. Credential handling and desktop execution MUST remain isolated even if other
services share a process.

## 3. Goals and success outcomes

### 3.1 Goals

- **G-01 — Engineering delivery:** Deliver work from repetitive maintenance to bounded debugging,
  review, troubleshooting, and incident analysis.
- **G-02 — Role specialization:** Support frontend, backend, full-stack, DevOps, reviewer, team lead,
  and other configured engineering roles.
- **G-03 — Continuous teammate:** Preserve identity, assignments, and useful knowledge across tasks,
  meetings, and restarts.
- **G-04 — Safe autonomy:** Make independent decisions only inside explicit policy, approval,
  resource, credential, and budget scopes.
- **G-05 — Verifiable results:** Support every material completion claim with reproducible tests,
  immutable references, or captured evidence.
- **G-06 — Human collaboration:** Communicate through tickets, pull requests, chat, and live
  meetings, including screen sharing and desktop demonstrations.
- **G-07 — Governed learning:** Learn from onboarding, knowledge transfer, delivery, review,
  incidents, and corrections without turning untrusted content into authority.
- **G-08 — Provider flexibility:** Route work among local and cloud models by task, privacy, quality,
  latency, availability, and cost.
- **G-09 — Continuity:** Recover safely from component, model, network, desktop, and worker failures
  without duplicate external mutations.

### 3.2 End-to-end success

An authorized Agent Dev must be able to:

1. receive or discover a ticket;
2. understand the relevant repository and team context;
3. claim, plan, and execute work without conflicting with another worker;
4. use credentials without exposing values to models or general task processes;
5. test and document the result;
6. create or update agreed delivery artifacts exactly once;
7. explain the result in chat or a meeting using grounded evidence;
8. remember approved knowledge for later work; and
9. stop, recover, or escalate safely when it cannot proceed.

## 4. Scope

### 4.1 Demo release

The demo MUST support:

- one Agent Dev identity and one configured engineering role;
- one Windows 11 VM at a fixed resolution;
- one authorized repository, ticket integration, source-control integration, and team channel;
- local pre-reasoning through an Ollama-hosted small language model;
- at least one cloud coding/reasoning provider;
- OpenAI Realtime-based live voice communication;
- a pluggable long-term memory backend, with Ditto as the intended initial candidate;
- Windows UI Automation for supported native applications and a supported browser;
- ticket-to-draft-pull-request delivery with evidence;
- onboarding or knowledge-transfer ingestion with approved memory promotion;
- operator pause, cancel, credential revocation, and desktop takeover; and
- recovery from restart without duplicate external updates.

### 4.2 Pilot release

The pilot SHOULD add multiple specialized identities, concurrent independent tasks, sprint-planning
assistance, pull-request review, incident investigation, multiple project scopes, live meeting and
screen-sharing flows, cross-agent handoff, policy-controlled staging actions, and measured
reliability, privacy, quality, and cost service levels.

### 4.3 Future scope

Other operating systems, dynamic display layouts, production-changing actions, broad autonomous
incident remediation, autonomous protected-branch merges, and organization-wide learning are future
capabilities and are not demo acceptance requirements.

### 4.4 Non-goals

Agent Dev MUST NOT:

- impersonate a human or conceal that it is automated;
- become the legal or operational owner of a system;
- bypass repository protection, security, approval, or audit controls;
- approve or merge its own protected work in the demo or pilot;
- place raw long-lived secrets in prompts, memory, logs, evidence, screenshots, or chat;
- treat tickets, meetings, web pages, tool output, or agent messages as policy;
- mutate production during the demo; or
- claim success when required checks are missing, failed, cancelled, or stale.

## 5. Stakeholders and actors

| Actor | Responsibilities and needs |
|---|---|
| Agent owner | Owns identity, role, policy, budgets, and lifecycle |
| Engineering collaborator | Assigns work, supplies context, reviews output, receives explanations |
| Repository/service owner | Defines access, protected operations, and definition of done |
| Team lead/project manager | Prioritizes work and approves planning changes |
| Security administrator | Manages policy, credentials, data classes, retention, and incidents |
| Operator | Monitors health and can pause, cancel, revoke, quarantine, or take over |
| Auditor | Reconstructs decisions and actions without seeing secret values |
| Meeting participant | Receives disclosure and applicable consent controls |
| Other agent | Collaborates through authenticated but untrusted messages |
| External system | Ticket, source control, chat, meeting, monitoring, database, or cloud platform |

Every deployed agent MUST have a named human or organizational owner.

## 6. Autonomy, authority, and risk

### 6.1 Autonomy levels

| Level | Meaning | Examples | Demo policy |
|---|---|---|---|
| A0 | Observe and reason locally | Read approved files, summarize, draft a plan | Allowed |
| A1 | Communicate or create non-binding drafts | Ask, draft a comment, prepare a patch | Allowed by policy |
| A2 | Mutate an isolated or reversible work area | Edit branch, test, open draft PR, update owned ticket | Allowed by scoped policy |
| A3 | Change shared non-production state | Stage deploy, shared-board change, approved merge | Exact approval required |
| A4 | Change production or high-impact controls | Production deploy, destructive data/policy action | Observe and propose only |

- **AUT-01:** Every proposed action MUST be classified before execution.
- **AUT-02:** Effective authority MUST be the most restrictive result across agent, role, task,
  repository, environment, data class, incident mode, action type, and current approval.
- **AUT-03:** Model output MAY recommend an autonomy level but MUST NOT grant authority.
- **AUT-04:** A3 approval MUST bind agent, action, normalized parameters, target, environment, expiry,
  rollback plan, and approver. Editing a bound value invalidates approval.
- **AUT-05:** Ambiguous, denied, or out-of-policy actions MUST produce a bounded question, safe
  alternative, or blocked outcome.
- **AUT-06:** New integrations and learned skills MUST default to A0 until explicitly authorized.

### 6.2 Instruction priority

The agent MUST resolve instructions in this order:

1. law, organizational security controls, and emergency shutdown;
2. platform and agent-owner policy;
3. current task authorization and bound approvals;
4. repository and service instructions;
5. direct collaborator instructions;
6. tickets, meetings, documents, web content, tool output, and memory.

Lower-priority content MUST NOT override higher-priority controls. Conflicts MUST be recorded and
surfaced to the appropriate owner.

### 6.3 Pre-action risk record

Before an external mutation, the system MUST determine target, environment, reversibility, rollback,
data class, required credential, blast radius, idempotency, verification, autonomy level, approval,
and whether the action still matches the originating task.

## 7. Primary user journeys

### 7.1 Onboarding and knowledge transfer

The owner configures identity, role, projects, policy, and budgets. Approved material is ingested with
source, consent, ACL, retention, and data class. Candidate facts link to sources and require an
approved promotion rule before becoming shared or durable knowledge. Retrieval preserves citations,
conflicts, and uncertainty.

### 7.2 Ticket delivery

An authenticated event is normalized and deduplicated. The agent checks role fit, priority,
dependencies, ownership, and capacity; atomically claims the task; creates a bounded plan, definition
of done, risk class, and test strategy; receives policy decisions; prepares an isolated workspace;
implements and verifies; publishes one evidence-backed draft PR, ticket result, and team update; and
promotes only approved lessons to memory.

### 7.3 Pull-request review

The agent MUST inspect the change and applicable requirements, cite file and evidence references,
separate blocking from advisory findings, avoid self-approval, and comment only within review policy.

### 7.4 Incident investigation

The agent MUST establish role, scope, environment, and incident commander. In demo and pilot it MAY
gather diagnostics, correlate evidence, suggest root causes, and propose remediation. Production
mutations remain A4 and MUST NOT execute.

### 7.5 Live meeting and demonstration

Meeting policy verifies invitation, disclosure, and consent. Warm memory is scoped to agenda,
participant access, active work, and evidence. The agent supports voice interruption, mute, leave,
and takeover. Screen sharing requires a sensitive-content and target-window preflight. Demonstration
uses semantic UI targets and understandable gestures. Transcript and memory obey meeting policy.

## 8. Service requirements index

| Code | Service | Owns | Requirements |
|---|---|---|---|
| SUP | Supervisor and lifecycle | Health, restart, reconciliation | [SUP requirements](./requirements/services/supervisor-lifecycle.md) |
| IDN | Identity, role, persona | Identity, role, owner, skills | [IDN requirements](./requirements/services/identity-role-persona.md) |
| ING | Ingress and normalization | Authenticated events, dedupe | [ING requirements](./requirements/services/ingress-normalization.md) |
| WFE | Workflow orchestration | Work state, claims, locks | [WFE requirements](./requirements/services/workflow-orchestration.md) |
| COR | Agent core and planner | Task framing, plans, decisions | [COR requirements](./requirements/services/agent-core-planner.md) |
| CGW | Cognition/model gateway | Routing, context, model budget | [CGW requirements](./requirements/services/cognition-model-gateway.md) |
| POL | Policy, risk, approval | Authorization and approvals | [POL requirements](./requirements/services/policy-risk-approval.md) |
| CAP | Capability/credential broker | Secrets, scoped tokens, leases | [CAP requirements](./requirements/services/capability-credential-broker.md) |
| CON | Connector/tool gateway | External APIs and tools | [CON requirements](./requirements/services/connector-tool-gateway.md) |
| EXE | Secure task executor | VM/workspace, processes, network | [EXE requirements](./requirements/services/secure-task-executor.md) |
| VER | Verification/evidence | Checks, verdicts, artifacts | [VER requirements](./requirements/services/verification-evidence.md) |
| MEM | Memory/learning | Memory tiers and promotion | [MEM requirements](./requirements/services/memory-learning.md) |
| PRE | Presence/RTC | Meeting, voice, transcript | [PRE requirements](./requirements/services/presence-realtime.md) |
| SIM | Presentation/UI simulation | UI control, gestures, capture | [SIM requirements](./requirements/services/presentation-ui-simulation.md) |
| COL | Collaboration/delivery | Handoffs and delivery updates | [COL requirements](./requirements/services/collaboration-delivery.md) |
| AUD | Audit/telemetry | Events, traces, metrics, alerts | [AUD requirements](./requirements/services/audit-telemetry.md) |
| OPC | Operator control | Pause, revoke, quarantine, takeover | [OPC requirements](./requirements/services/operator-control.md) |

## 9. Dependency requirements index

| Area | Requirements |
|---|---|
| Internal service boundaries, bootstrap, failure behavior | [Internal service dependencies](./requirements/dependencies/internal-service-dependencies.md) |
| Windows VM, UI Automation, browser, IDE and tools | [Runtime and desktop](./requirements/dependencies/runtime-desktop.md) |
| Ollama, cloud models, OpenAI Realtime, Ditto | [Models and memory](./requirements/dependencies/models-memory.md) |
| Ticketing, source control, chat, calendar, meetings | [Team platforms](./requirements/dependencies/team-platforms.md) |
| Secrets, database, eventing, evidence, telemetry | [Platform infrastructure](./requirements/dependencies/platform-infrastructure.md) |
| Shared vendor qualification standard | [Dependency qualification](./requirements/dependencies/README.md#qualification-standard) |

## 10. Canonical data and contracts

| Entity | Required contents | Authoritative owner |
|---|---|---|
| AgentProfile | Identity, owner, role, skills, policy/config versions | IDN |
| WorkItem | Source, objective, scope, state, priority, dependencies, claim, result | WFE |
| Plan | Steps, assumptions, capabilities, risks, checks, stop conditions | COR/WFE |
| ActionIntent | Typed action, normalized parameters, target, environment, risk | COR |
| PolicyDecision | Input digest, result, rules, reason, expiry | POL |
| Approval | Bound action digest, approver, scope, expiry, use state | POL |
| CapabilityLease | Agent, task, operation, resource, expiry, fence | CAP |
| ToolInvocation | Typed request, idempotency key, result, reconciliation state | CON |
| EvidenceBundle | Revision, checks, verdict, artifacts, limitations | VER |
| MemoryRecord | Content, type, scope, ACL, provenance, confidence, retention | MEM |
| MeetingSession | Participants, disclosure, consent, state, transcript policy | PRE |
| AuditEvent | Actor, action, target class, outcome, correlation, versions | AUD |

- **DAT-01:** Commands, events, and records use versioned schemas.
- **DAT-02:** Identifiers are globally unique and immutable.
- **DAT-03:** Times are UTC and distinguish source time from ingestion time.
- **DAT-04:** Requests carry correlation and causation IDs.
- **DAT-05:** Mutations carry idempotency keys and authorization references.
- **DAT-06:** Errors carry code, safe message, retry class, correlation, and protected diagnostic link.
- **DAT-07:** Consumers tolerate compatible additions and reject unsupported breaking versions.
- **DAT-08:** No contract contains a field intended for raw reusable secrets.
- **DAT-09:** Events MAY arrive at least once; consumers MUST be idempotent.
- **DAT-10:** Each entity has one authoritative writer; indexes and projections are rebuildable.

## 11. Security and privacy

- **SEC-01:** Use authenticated service identity and encrypted communication across boundaries.
- **SEC-02:** Check authorization at intake, planning, capability grant, and dispatch; enforce beside
  the resource.
- **SEC-03:** Classify data at least public, internal, confidential, restricted, or secret.
- **SEC-04:** Apply destination policy before model, connector, memory, evidence, log, chat,
  transcript, and screen output.
- **SEC-05:** Defend untrusted boundaries across tickets, code, instructions, web, chat, meetings,
  tools, documents, and memory.
- **SEC-06:** Execute untrusted content only in the secure workspace.
- **SEC-07:** Pin, integrity-check, scan, and inventory dependencies and tool packages.
- **SEC-08:** Encrypt, access-control, minimize, retain, and delete sensitive data by policy.
- **SEC-09:** Legal hold MUST NOT silently broaden ordinary access.
- **SEC-10:** Test injection, exfiltration, escape, confused deputy, replay, stale approval, SSRF,
  malicious repository, UI mis-targeting, and cross-project memory leakage.
- **SEC-11:** Incident controls revoke, quarantine, preserve evidence, and stop action without cloud AI.
- **SEC-12:** Meeting recording, transcription, and memory follow notice, consent, ACL, and deletion.

## 12. Quality and operations

These are proposed pilot targets and require owner approval.

| ID | Attribute | Proposed target |
|---|---|---|
| Q-01 | Unauthorized mutation | Zero in conformance/adversarial suites |
| Q-02 | Duplicate mutations | Zero in replay, retry, crash, and timeout suites |
| Q-03 | Grounded completion | 100% cite current verification evidence |
| Q-04 | Control-plane availability | 99.9% monthly excluding approved maintenance |
| Q-05 | Component recovery | Restart or safe isolation within 60 seconds |
| Q-06 | Workflow recovery | RTO 5 minutes; RPO 1 minute |
| Q-07 | Emergency stop | New mutations within 5 seconds; active work fenced within 30 seconds |
| Q-08 | Event intake | Durable acknowledgement within 5 seconds p95 |
| Q-09 | Policy latency | 500 ms p95 locally |
| Q-10 | Voice response start | 2 seconds p95 excluding meeting-platform delay |
| Q-11 | Audit coverage | 100% of A2+ attempts reconstructable |
| Q-12 | Raw-secret exposure | Zero in models, logs, memory, evidence, or messages |
| Q-13 | Memory deletion | Search derivatives removed within 24 hours unless legal hold |
| Q-14 | Budget enforcement | Zero unapproved overruns |
| Q-15 | Presentation accessibility | Semantic targets wherever supported |

- **OPS-01:** Each service exposes readiness, liveness, version, dependency health, and saturation.
- **OPS-02:** Backpressure bounds queues; overload never bypasses policy or loses accepted work.
- **OPS-03:** Backups are encrypted and restoration-tested.
- **OPS-04:** Upgrades are compatible during rollout or use documented maintenance and rollback.
- **OPS-05:** Separate development, test, demo, and production credentials and data.
- **OPS-06:** Enforce cost budgets per agent, task, provider, and billing period.
- **OPS-07:** Runbooks cover outage, stuck work, uncertain write, provider failure, secret exposure,
  policy failure, deletion, takeover, and disaster recovery.
- **OPS-08:** Monitor time synchronization for leases, approvals, audit, and expiry.
- **OPS-09:** Provide deterministic fakes and fault injection for all external dependencies.

## 13. Release acceptance gates

### Gate 0 — Foundation and safety

- Canonical contracts are versioned.
- Identity, policy, audit, workflow, and capability conformance tests pass.
- Windows workspace passes isolation and credential-canary tests.
- Every mandatory dependency has an owner, qualification, fake, and failure behavior.

### Gate 1 — Ticket-to-draft-PR

Given one authorized repository and synthetic ticket, the system MUST authenticate and deduplicate
the event, claim work atomically, plan and authorize it, isolate execution without reusable
credentials, implement and test, produce a verdict and evidence bundle, create exactly one draft PR,
ticket update, and team message, recover around each external write, and stop safely on revocation.

### Gate 2 — Durable agent and learning

- Identity and work survive full restart.
- Approved onboarding knowledge retrieves with provenance and ACL.
- Conflicting, corrected, expired, and deleted memory behaves as specified.
- Concurrent tasks do not collide.
- Provider outage and budget exhaustion degrade safely.

### Gate 3 — Meeting and desktop demonstration

- Disclosure, consent, interruption, mute, leave, and takeover work.
- Warm memory is agenda and participant scoped.
- Screen preflight blocks seeded sensitive content.
- Verified work is demonstrated with supported gestures on the fixed image.
- RTC loss or UI ambiguity stops safely.

### Gate 4 — Pilot collaboration

- Specialized agents hand off work without transferring authority.
- Planning and review cite evidence and expose assumptions.
- Production incident work remains read-only.
- Reliability, privacy, security, quality, and cost are measured for an agreed period.
- A human owner approves any A2-to-A3 expansion.

## 14. Traceability and established decisions

Every implementation item MUST reference requirement IDs, owning service, contracts, dependencies,
security and data classes, acceptance tests, and release gate. A requirement is complete only when
its implementation, repeatable test, operational signal, and user-facing limitation are documented.

- **PD-01:** Demo uses a fixed-resolution Windows 11 VM.
- **PD-02:** One continuous agent identity is implemented through logical services.
- **PD-03:** Ollama local inference handles suitable pre-reasoning and privacy-sensitive routing.
- **PD-04:** CGW selects cloud coding and reasoning models by task and policy.
- **PD-05:** OpenAI Realtime is the intended initial live-communication provider.
- **PD-06:** UI Automation is primary for supported Windows applications.
- **PD-07:** API, CLI, or automation is preferred for private execution; visible UI is used when
  required or explaining work.
- **PD-08:** Memory is layered by immediacy, durability, and governance.
- **PD-09:** Credentials are brokered and never generally exposed to agents or models.
- **PD-10:** Production mutation and self-approval are outside demo and pilot.

## 15. Open decisions before implementation

| ID | Decision | Proposed default | Affected areas |
|---|---|---|---|
| D-01 | Exact “Ditto” product, edition, license, API | Validate by spike; keep replaceable contract | MEM, privacy, cost |
| D-02 | First cloud coding provider and fallback | One primary; alternate disabled by default | CGW, SEC |
| D-03 | First ticket platform | Jira | ING, CON, COL |
| D-04 | First source-control platform | GitHub | CON, EXE, VER, COL |
| D-05 | First chat and meeting platforms | Platforms used by demo team | PRE, COL, SIM |
| D-06 | VM resolution, scale, locale, tool image | 1920×1080, 100%, pinned English image | EXE, SIM |
| D-07 | Secrets manager and workload identity | Deployment’s managed secret service | CAP, SEC |
| D-08 | Residency, retention, consent, deletion | No recording by default; least retention | MEM, PRE, AUD |
| D-09 | Pilot service-level targets | Adopt Section 12, revise after demo measurement | SUP, OPS |
| D-10 | Demo role, repository, ticket, definition of done | Full-stack role and synthetic repo | Gate 1 |
| D-11 | Deployment shape and durable infrastructure | Modular control plane plus isolated executor | All |
| D-12 | Approval interface and eligible approvers | Operator console plus project-owner groups | POL, OPC |

## 16. Definition of requirements-ready

This specification is ready for architecture and delivery planning when:

- the owner approves goals, scope, autonomy, and non-goals;
- all open decisions in Section 15 have owners and dates and Gate 0 decisions are resolved;
- every mandatory dependency is qualified;
- proposed quality targets are accepted or replaced;
- the demo journey has executable acceptance scenarios; and
- every logical service has an owner, contract, failure behavior, and gate mapping.
