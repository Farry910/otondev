# Agent Dev — Architecture v2

**Status:** proposed architecture, not implemented  
**Product origin:** [`primary_messy_design.md`](../01-product/primary_messy_design.md)  
**Component designs:** [`02-architecture/README.md`](README.md)

## 1. Executive decision

The idea is viable as a **governed autonomous software-engineering platform**, but not as one
large process with broad credentials and an always-open desktop. The safe unit is a durable
**logical agent identity** backed by a control plane, isolated task workers, a provenance-aware
memory service, and an optional Windows presence desktop.

The system optimizes for this order:

1. protect people, credentials, data, and production;
2. tell the truth about what happened;
3. recover deterministically;
4. deliver verified engineering work;
5. feel responsive and person-like.

“Alive” means continuous service, stable identity, and resumable work. It does not mean
consciousness, exemption from supervision, or an impossible promise that software never fails.
The agent MUST identify itself as an AI teammate; human-like voice and cursor motion MUST NOT be
used to mislead participants.

## 2. Goals, boundaries, and invariants

### Goals

- A named, role-specialized agent can discover, plan, implement, verify, and report a bounded task.
- It can collaborate through the team's normal systems and attend an authorized meeting.
- It learns from approved evidence and feedback while retaining provenance and respecting deletion.
- It resumes after failures without repeating external side effects.
- Model and tool choices are replaceable and governed by task risk, data policy, quality, latency,
  and cost—not only by persona role.

### Non-goals for the first product

- unsupervised production changes or incident remediation;
- autonomous merging to protected branches;
- storing every event forever;
- pretending the agent is human;
- arbitrary desktop control during normal work;
- simultaneous support for every OS, IDE, ticket board, meeting platform, and cloud;
- strong artificial general intelligence or self-directed goals outside team policy.

### System invariants

1. Model output is a **proposal**, never authorization.
2. Untrusted text from tickets, repos, logs, chat, web pages, and memory cannot grant capability.
3. Every external mutation has policy authorization, a scoped capability, an idempotency key, and
   an audit event.
4. Operational workflow state is separate from semantic memory.
5. Durable truth comes from source systems and evidence; distilled memories cite their sources.
6. Long-lived general-purpose credentials are unavailable to models and task processes.
7. High-risk actions require an approval bound to the exact action digest and expiry.
8. Screen sharing and recording require meeting policy, disclosure, and a privacy preflight.
9. Recovery prefers replay of deterministic state over repeating an uncertain side effect.
10. An emergency stop denies new capabilities first, then cancels or contains running work.

## 3. Architecture at a glance

The architecture has four planes. A single-agent demo can deploy several components together,
but the contracts and trust boundaries remain separate.

```text
                           TEAM SYSTEMS
        Jira/Linear · Git forge · chat · calendar · monitoring · meetings
             | signed webhooks                         ^ brokered API calls
             v                                         |
+------------------------------- CONTROL PLANE -------------------------------+
| Event ingress + dedupe  -> Durable workflow / scheduler -> Agent runtime    |
|                                      |                    (logical identity) |
| Identity + RBAC -> Policy/approval <-+-> Cognition gateway                  |
| Capability + credential broker       |   (model/data/risk routing)           |
| Audit log + observability            |                                       |
+--------------------+-----------------+--------------------+------------------+
                     | leased commands                      |
        +------------+-------------+            +----------+----------------+
        | EXECUTION PLANE           |            | PRESENCE PLANE             |
        | Ephemeral task sandbox    |            | Dedicated Windows desktop |
        | repo worktree/container   |            | interactive companion     |
        | CLI/API/tool adapters     |            | meeting/audio/controller  |
        | verifier + artifact agent |            | safe-share overlay        |
        +------------+-------------+            +----------+----------------+
                     | evidence                             | transcript/events
                     +------------------+-------------------+
                                        v
        +------------------------------ DATA PLANE ---------------------------+
        | Operational DB | append-only audit | artifact/object store          |
        | Ditto-backed memory projection | optional retrieval index           |
        +--------------------------------------------------------------------+
```

### Why this shape

- The **control plane** holds authority and durable workflow state; it does not run repository code.
- **Task sandboxes** are disposable because source trees, dependencies, tests, and tool output are
  untrusted. A worker receives only task-scoped capabilities.
- The **presence desktop** is persistent enough to feel like the agent's own workstation, but is a
  presentation surface with minimal credentials—not the place where untrusted builds and prod
  administration coexist.
- The **data plane** separates correctness-critical state, audit evidence, large artifacts, and
  fallible learned knowledge.

This is still compatible with “one secure box per agent” as a product metaphor. The Secure Box is
a **trust zone and namespace**, not necessarily one VM or one process.

## 4. Major components

| Component | Owns | Must not own |
|---|---|---|
| Event ingress | webhook verification, normalization, dedupe | model reasoning |
| Workflow engine | durable task FSM, leases, timers, retries, compensation | semantic memory |
| Agent runtime | identity, priorities, plan selection, coordination | raw credentials |
| Policy/approval service | authorization decision, autonomy level, approval binding | task execution |
| Cognition gateway | model routing, context construction, budgets, response validation | action authority |
| Capability broker | short-lived, narrowly scoped tool tokens | general model prompts |
| Tool/connector broker | typed Jira/Git/chat/cloud operations | arbitrary shell commands |
| Workspace manager | isolated checkout, sandbox lifecycle, resource limits | durable identity |
| Task executor/verifier | implementation and independent verification | merge authorization |
| Memory service | source-linked episodic/semantic/people/decision knowledge | workflow truth |
| Presence service | meeting lifecycle, audio, turn-taking, disclosure | unattended prod work |
| Presentation controller | safe desktop navigation, overlays, screen-share preflight | normal task execution |
| Audit/observability | immutable action trail, metrics, traces, alerts | secret payloads |
| Supervisor | liveness, restart, fencing, version rollout | business decisions |

Detailed component contracts are in the linked [component index](README.md).

## 5. Durable agent lifecycle

The agent runtime follows **observe → interpret → propose → authorize → execute → verify → commit →
reflect**, not a free-running prompt loop.

```text
RECEIVED -> TRIAGED -> PLANNED -> WAITING_AUTH -> LEASED -> EXECUTING
                                                        -> VERIFYING
                                                        -> DELIVERING -> DONE

Any active state may enter WAITING_INPUT, BLOCKED, PAUSED, FAILED, or CANCELLED.
An interrupted non-terminal workflow may enter RECOVERING only after the prior lease is fenced;
FAILED is terminal and a deliberate retry creates a linked workflow.
```

- A compare-and-set transition version prevents two agents from claiming the same work.
- A lease has an owner, expiry, and fencing token. An expired worker cannot continue mutating state.
- Each external action uses `action_id` as its idempotency key. On an ambiguous timeout, the engine
  reconciles with the source system before retrying.
- Checkpoints store sanitized inputs, output references, tool versions, commit SHA, and next safe
  transition. They do not blindly serialize model context or secrets.

See [Agent Core](components/agent-core.md), [Task Engine](components/task-engine.md), and
[contracts](contracts-and-data.md).

## 6. Autonomy model

Autonomy is assigned per action, environment, repository, and agent—not as a personality trait.

| Level | Meaning | Examples |
|---|---|---|
| A0 Observe | read and summarize | inspect ticket, build warm-up brief |
| A1 Draft | create non-authoritative output | plan, suggested review, RCA draft |
| A2 Reversible non-prod | mutate isolated/team systems | create branch, open draft PR, comment |
| A3 Privileged non-prod | higher-impact controlled action | deploy to test, change shared staging |
| A4 Production | customer/availability impact | prod deploy, infrastructure mutation |

The first release targets A0–A2. A3 requires explicit, action-bound approval. A4 is read-only
diagnosis plus human-operated remediation until a separate production-safety program succeeds.
The policy engine evaluates actor, action, resource, environment, data class, provenance, current
incident state, cost, and approval—not just `policy.yaml` strings.

## 7. Cognition and model routing

The local SLM is useful for cheap classification and private processing, but it is not a security
boundary. Routing follows these gates:

1. **Normalize and label data** using deterministic source rules; unknown defaults to restricted.
2. **Assess action risk** and whether untrusted content is present.
3. **Choose allowed providers** for the data residency/classification policy.
4. **Choose capability** by measured task performance.
5. **Fit latency, availability, and cost budgets** and select a pinned model version.
6. **Validate the structured result**; a separate policy decision authorizes any action.

Provider access passes through the cognition gateway, but TLS interception is not the main control.
Official SDK clients call the gateway or an allow-listed provider directly with workload identity;
browser, WebRTC, SaaS, and arbitrary third-party traffic cannot all be reliably content-redacted by
one universal proxy. Sensitive fields are excluded before context construction, and outbound DLP is
a detection/backstop layer.

OpenAI Realtime is a valid option for low-latency voice because the current API supports realtime
audio/text over WebRTC, WebSocket, or SIP and supports function calling. It remains behind a provider
adapter and is not an architectural dependency.

## 8. Secure execution and credentials

Every task runs in a fresh workspace or snapshot with:

- a task-specific OS user/container/VM boundary;
- explicit repository and network allow-lists;
- CPU, memory, disk, time, and spend limits;
- no inherited desktop session, browser profile, or long-lived credentials;
- typed broker calls for Jira/Git/chat/cloud actions;
- short-lived tokens scoped to one action or workflow;
- egress DNS/IP policy plus logs; and
- artifact scanning before anything is published.

Windows Credential Manager/DPAPI can protect demo secrets at rest, but DPAPI protection is tied to
the user/security context and requires a recovery strategy. Production SHOULD use an enterprise
vault/workload identity and make the broker the only component that can retrieve secrets. The agent
and model receive opaque resource handles, not secret values.

Tickets, PRs, code comments, test output, logs, chat, web pages, screenshots, and retrieved memories
are untrusted. The architecture isolates their parsing from privileged action selection and validates
every tool call against original intent and policy. See [Security](security-and-credentials.md).

## 9. Memory and learning

The hardware-cache analogy describes latency, not truth. The memory system uses:

- **L0 active context:** bounded prompt/session state;
- **L1 warm set:** precomputed, source-linked facts for the current task or meeting;
- **L2 local knowledge:** recent per-agent records and retrieval index;
- **L3 durable memory:** Ditto-backed source and derived records with provenance, ACL, retention,
  confidence, and supersession metadata;
- **archive:** encrypted raw artifacts/transcripts when retention policy permits.

Ditto remains the proposed memory substrate, especially for local-first and selective sync. It is not
the workflow/approval/lease system of record: its sync model is causally consistent, concurrent edits
can merge under CRDT rules, and subscription scope affects which transaction changes reach a peer.

“Learn from every event” becomes “offer every eligible event to ingestion.” Consent, data class,
retention, relevance, and source quality determine what is stored. Model-generated reflection cannot
overwrite source evidence. Corrections and deletion tombstones propagate to derived memories.

## 10. Presence and screen explanation

The Windows presence desktop has two processes:

1. a non-interactive supervisor/service; and
2. a least-privilege companion launched in the logged-in user's interactive session and connected
   through authenticated local IPC.

This split is mandatory because modern Windows services do not directly interact with the user
desktop. The desktop companion joins the selected meeting adapter, runs disclosure/consent checks,
and performs a safe-share preflight: close notifications, select only the intended window, mask
sensitive regions, verify branch/commit, and rehearse navigation.

The “Simulation Service” is therefore a **Presentation Controller**. It uses accessibility/UIA or a
browser adapter, stable semantic targets, postcondition checks, and an annotation overlay. Human-like
cursor easing is cosmetic and optional; correctness and transparency matter more.

Realtime conversation and background work may overlap, but only if resource locks and a priority
policy prevent screen, microphone, repository, and attention conflicts. The agent should not live-edit
the same branch while presenting it.

## 11. Fleet and agent-to-agent collaboration

Agents collaborate through the same governed workflows used for humans and external systems. The
fleet scheduler atomically claims work, enforces per-agent/team budgets, and prevents ticket, branch,
environment, meeting, and review conflicts. There is no unrestricted agent-to-agent backchannel.

An agent-to-agent handoff is an authenticated event containing the source task, immutable code/evidence
references, requested outcome, known limitations, budget, and expiry. It is untrusted input to the
recipient and cannot transfer the sender's approval or capabilities. Recursive handoffs have depth,
time, and cost limits. Shared memories are separately approved team records; private identity and
people records do not propagate by default.

For separation of duties, an agent may provide a non-binding review of another agent's work, but it
cannot turn a review request into protected-branch approval in the pilot. Fleet observability attributes
every action to the logical agent, model/tool/config versions, workload, and originating human/team goal.

## 12. Evidence, audit, and observability

Screenshots are supporting evidence, not proof. A delivery evidence bundle includes:

- task and workflow IDs;
- repo URL, immutable commit SHA, base SHA, and clean/dirty state;
- exact commands/tool versions and normalized exit status;
- signed or hashed test/CI logs and artifact references;
- policy decision and approval references;
- model/provider/version and prompt-template hash (without secrets);
- external action IDs/URLs; and
- verifier verdict plus known limitations.

Screenshots or recordings are captured only when needed, cropped to the relevant surface, scanned for
sensitive content, encrypted, and retained by policy. The audit log records who/what/when/result and
hashes sensitive payloads rather than storing secrets.

## 13. Availability and recovery

Replace “must never die” with measurable initial targets:

- control-plane monthly availability target: 99.5% for pilot;
- acknowledged event durability: no loss under a tested single-node process restart;
- recovery point objective: at most one unacknowledged transition;
- recovery time objective: 5 minutes for orchestration, 15 minutes for presence desktop;
- duplicate external mutations: zero in the conformance suite;
- emergency stop propagation: under 10 seconds to deny new capabilities.

These are proposed pilot targets, not achieved claims. High availability later requires replicated
control-plane storage, redundant schedulers with leader election, fenced workers, backups, and restore
drills. A watchdog alone cannot cover VM, host, network, provider, or data-store failure.

## 14. Deployment profiles

### Local development

One machine; stub connectors; local operational DB; one sandbox; no real credentials or meetings.

### Controlled demo

One logical agent, one dedicated Windows presence VM, isolated task workers, one repository, one ticket
project, A0–A2 permissions, synthetic incident data, and a second logical identity only if the
single-agent path is stable.

### Pilot

Central control plane, enterprise identity/vault, several agents, production data read-only, formal
retention/consent, on-call human operator, and continuous adversarial evaluation.

### Production

Only after security review, recovery drills, red-team gates, measured task quality, provider/data
agreements, and explicit authorization for each expanded autonomy level.

## 15. Technology posture

Choose contracts first and implementations after spikes. Reasonable starting points are:

| Concern | Proposed starting point | Decision gate |
|---|---|---|
| durable workflows | Temporal, durable queue + SQL, or equivalent | crash/idempotency spike |
| operational store | transactional relational DB | HA/RPO needs |
| memory | Ditto adapter + optional retrieval index | provenance/deletion/sync tests |
| agent runtime | Python or TypeScript | team skills and SDK support |
| Windows companion | .NET + UIA/FlaUI | meeting-platform spike |
| task isolation | container/VM by workload OS | untrusted-code threat test |
| secret broker | enterprise vault/workload identity | customer environment |
| voice | provider adapter; OpenAI Realtime candidate | latency/cost/privacy eval |
| browser automation | Playwright adapter | target-app compatibility |
| telemetry | OpenTelemetry-compatible signals | operations stack |

Model names and vendor tools belong in versioned configuration, not architecture invariants.

## 16. Delivery recommendation

Do not attempt the old eight-week all-feature fleet demo. Build risk-first vertical slices:

1. **Governed task slice:** signed ticket event → plan → approval/policy → isolated change → tests →
   draft PR → evidence, with crash and duplicate-event tests.
2. **Memory slice:** source-linked feedback changes a later plan; correction and deletion also work.
3. **Presence slice:** disclosed bot joins a controlled meeting, gives a grounded update, and shares a
   sanitized window.
4. **Second agent and incident slice:** only after the first three meet their gates; incident remains
   read-only diagnosis and RCA.

The detailed gates and estimates are in [delivery-plan.md](../04-delivery/delivery-plan.md).

## 17. Decisions still required

1. Target customer and regulatory/data residency constraints.
2. One initial ticket system, chat system, Git forge, and meeting platform.
3. Exact Ditto product/API and supported Windows/server SDK version.
4. Source-code/data classes allowed at each model provider.
5. First repository/language and its deterministic definition of done.
6. Identity disclosure, recording consent, transcript retention, and right-to-delete policy.
7. Enterprise identity/vault available for the pilot.
8. Team size, infrastructure, and acceptable pilot SLO/cost budget.

Until these are answered, technology choices remain proposals rather than commitments.
