# Implementation plan — independently buildable services

**Status:** proposed v1; execution plan for [architecture v2](../02-architecture/architecture-v2.md)
**Related:** [Delivery plan](../04-delivery/delivery-plan.md) · [Contracts](../02-architecture/contracts-and-data.md) ·
[Operations](../05-operations/operations-and-evaluation.md) · [Security](../02-architecture/security-and-credentials.md)

This document decomposes architecture v2 into work packages that **separate sessions can build
concurrently without coordinating**. [delivery-plan.md](../04-delivery/delivery-plan.md) answers *what order risk
should be retired in*. This document answers *who can type at the same time without colliding*.

---

## 1. What makes a package independent

A work package qualifies as independently buildable only when all six hold:

| # | Property | Enforcement |
|---|---|---|
| 1 | Owns exactly one top-level directory | CI path-ownership check |
| 2 | Its public surface is declared in `packages/contracts`, not in its own code | import-boundary lint |
| 3 | It consumes every peer through an interface, never a concrete import | import-boundary lint |
| 4 | It ships a **fake** of itself that passes the same conformance suite as the real one | fake-parity test |
| 5 | It owns its own storage schema; no peer reads its tables | migration path ownership |
| 6 | Its tests run green with **all peers faked** and no network | `pnpm test` offline gate |

Property 4 is the load-bearing one. If the fake and the real implementation are verified by one shared
conformance suite, a session building the Connector Broker can trust the Policy fake without ever
reading Policy's source, and the trust survives Policy being rewritten later. Fakes that are not
parity-tested rot within days and silently destroy the parallelism they were meant to create.

---

## 2. Stack assumptions

The design docs leave language, forge, tracker, chat, meeting platform, and Ditto version open. Those
decisions do not change the decomposition, so this plan proceeds on stated assumptions rather than
blocking. Each is isolated behind an adapter and is cheap to revisit.

| Decision | Assumption | Why it is safe to assume now |
|---|---|---|
| control-plane language | TypeScript, Node 22, pnpm workspaces | one language across ingress/policy/connectors; strong schema-to-type codegen; `.NET` companion and any Python executor consume emitted JSON Schema |
| schema source of truth | Zod in `packages/contracts`, JSON Schema emitted for other languages | single definition, runtime validation, cross-language artifacts |
| operational store | one PostgreSQL instance, **schema per service**, no cross-schema joins | preserves the boundary at pilot scale without 15 databases |
| durable workflow | interface + Postgres reference implementation; Temporal remains an adapter choice | honours the crash/idempotency spike gate in [delivery-plan.md](../04-delivery/delivery-plan.md#stage-0--decisions-and-spikes-roughly-12-weeks) |
| deployment shape | modular monolith for the control plane; separate processes only where a **trust boundary** demands it | architecture v2 §3 explicitly permits colocation while keeping contracts separate |
| forge / tracker / chat | GitHub, Jira, Slack | adapter-shaped; swapping one is a package-local change |
| meeting platform | **undecided — genuine blocker for S15/S16** | see §7 |

### Processes that MUST stay separate

Colocation is a deployment convenience, never a boundary relaxation. These run as their own processes
with their own identity regardless of pilot scale:

- **Capability broker** — the only component permitted to retrieve secrets.
- **Task worker** — runs untrusted repository code.
- **Verifier worker** — must not share a process, context, or publish capability with the executor.
- **Presence companion** — interactive Windows session, least privilege.
- **Windows supervisor** — session 0, non-interactive.

Everything else MAY start colocated behind its interface and be extracted later without contract change.

---

## 3. Wave 0 — Foundation (one session, serial, blocking)

Wave 0 is the serialization point. **Nothing else starts until it lands.** Attempting to parallelize
Wave 0 produces exactly the contract churn this plan exists to prevent.

| Item | Deliverable |
|---|---|
| W0-A repo scaffold | pnpm workspace, `tsconfig.base`, lint, test runner, CI, import-boundary rules (`dependency-cruiser`), path-ownership check, `docker-compose.dev.yml` |
| W0-B contracts | every schema in [contracts-and-data.md](../02-architecture/contracts-and-data.md) as Zod + emitted JSON Schema; envelope validation; version negotiation with **fail-closed on unknown major**; the error-code enum |
| W0-C testkit | fake clock, deterministic ID generator, fault-injection helpers, golden-file harness, the **conformance-suite runner** and its fake-parity driver |
| W0-D SDK and fakes | typed client interface for every service in §4, plus a minimal in-memory fake for each, registered in one place |
| W0-E cross-cutting hooks | the `deny()` / `quarantine()` / `revoke()` hook interface every service must implement for emergency stop, and the structured-logging + OTel bootstrap |

**Exit criteria.** A trivial consumer can be written against any service interface, run its tests with
every peer faked, offline, and green. The fake-parity driver runs and reports.

W0-D deliberately ships *minimal* fakes. Each Wave-1 owner deepens their own fake as their first
commits, which is why fake depth never blocks a downstream session.

---

## 4. Work packages

`Gate` marks a prerequisite outside the package's control. `Proc` marks a mandatory separate process.

### Control plane

| ID | Package | Owns | Gate | Proc | Stage |
|---|---|---|---|---|---|
| S1 | Event Ingress and Dedupe | `services/ingress` | — | | 1 |
| S2 | Workflow Engine | `services/workflow` | — | | 1 |
| S3 | Agent Core Runtime | `services/core` | — | | 1 |
| S4 | Policy and Approval | `services/policy` | — | | 1 |
| S5 | Capability and Credential Broker | `services/broker` | — | ● | 1 |
| S6 | Cognition Gateway | `services/cognition` | — | ● | 1 |
| S7 | Connector Broker | `services/connectors` | — | | 1 |
| S8 | Audit and Telemetry | `services/audit`, `packages/telemetry` | — | | 1 |

### Execution plane

| ID | Package | Owns | Gate | Proc | Stage |
|---|---|---|---|---|---|
| S9 | Evidence and Artifact Store | `services/evidence` | — | | 1 |
| S10 | Workspace and Sandbox Manager | `services/workspace` | isolation spike | ● | 1 |
| S11 | Task Executor and Tool Runner | `services/executor` | S10 policy shape | ● | 1 |
| S12 | Verifier and Definition of Done | `services/verifier` | — | ● | 1 |

### Data plane

| ID | Package | Owns | Gate | Proc | Stage |
|---|---|---|---|---|---|
| S13 | Memory Service core | `services/memory` | — | | 2 |
| S14 | Ditto storage adapter | `services/memory-ditto` | Ditto spike | | 2 |

### Presence plane

| ID | Package | Owns | Gate | Proc | Stage |
|---|---|---|---|---|---|
| S15 | Presence Service | `services/presence` | meeting platform | | 3 |
| S16 | Presentation Controller | `windows/companion` | Windows spike | ● | 3 |
| S17 | Windows Supervisor | `windows/supervisor` | Windows spike | ● | 3 |

### Cross-cutting

| ID | Package | Owns | Gate | Proc | Stage |
|---|---|---|---|---|---|
| S18 | Operator Control and Emergency Stop | `services/operator` | W0-E hooks | | 1 |
| S19 | Evaluation and Conformance Harness | `eval/` | — | | 1 |
| S20 | Integration and Vertical Slice | `integration/`, dev env | rolling | | 1 |

---

## 5. Package briefs

Each brief states scope, what it fakes, storage, and the exit tests. Required tests are drawn from the
"Required tests" sections of the component design documents; a package is not done until they pass.

### S1 — Event Ingress and Dedupe
Per-source webhook signature verification, replay window, schema and size limits, normalization to
`agentdev.event.v2`, dedupe on `(tenant, source, source_event_id)`, durable enqueue, and
**acknowledge only after** authentication, dedupe persistence, and enqueue all succeed.
*Fakes:* workflow engine, audit. *Storage:* `ingress` schema (dedupe ledger, raw payload refs).
*Exit:* duplicate webhook returns the existing canonical event ID; out-of-order source version is
retained without rolling state backward; bad signature, oversized payload, and unknown schema major
all fail closed; crash between persist and ack does not lose or duplicate an acknowledged event.

### S2 — Workflow Engine
The state machine of [contracts §3](../02-architecture/contracts-and-data.md#3-workflow-record-and-state-machine):
compare-and-set on `state_version`, leases with owner/expiry/**fencing token**, timers and wakeups,
retry and backoff, compensation hooks, the recovery scan, and a transition event per change. Built
behind a `WorkflowEngine` interface so the Temporal-vs-Postgres decision stays open.
*Fakes:* everything. *Storage:* `workflow` schema.
*Exit:* two claimants on one workflow — exactly one wins; an expired worker's write is fenced; crash
mid-transition resumes at a safe state; terminal states reject transitions; pause and cancel complete
only after capabilities are denied and the lease is fenced.

### S3 — Agent Core Runtime
Versioned identity record, triage, plan assembly, `DecisionRequest` construction, the named-resource
concurrency table and priority ladder from [agent-core.md](../02-architecture/components/agent-core.md#concurrency-and-arbitration),
status derived from workflow truth, update coalescing, and restart recovery orchestration.
*Fakes:* all peers. *Storage:* `core` schema (identity versions, resource locks).
*Exit:* concurrent meeting plus background task arbitrates correctly; a completion claim without
evidence is rejected; operator pause during a model call, a test run, and delivery each contain safely;
the Core never treats model output as an authorization.

**Risk note.** S3 touches every interface and is the natural integration hotspot. It should be built by
the session that also owns S20, or reviewed at every S20 milestone.

### S4 — Policy and Approval
Deterministic evaluation over actor, action, resource, environment, data class, provenance, incident
mode, cost, and approval. Effective autonomy is the **minimum** across agent, repository, environment,
data class, incident mode, and action type. Signed, versioned policy bundles. Approval records bound to
actor, action, normalized parameter digest, resource, environment, expiry, and `max_uses`.
*Fakes:* audit. *Storage:* `policy` schema.
*Exit:* editing any bound field invalidates an approval; a consumed or expired approval cannot be
replayed; unknown input denies; chat text, emoji, ticket labels, and model output never produce an
approval record; every decision is reproducible from its logged inputs and bundle hash.

### S5 — Capability and Credential Broker ●
Mints signed capabilities bound to subject, workflow, action ID, operation, resource, parameter
constraints, `max_uses`, fencing token, expiry, and revocation epoch. Retrieves secrets **only** for a
trusted adapter and never returns a secret value to a caller. Revocation, epoch bump, rotation, and the
emergency deny path. Vault interface with a dev file-backed implementation and a DPAPI implementation
for the controlled demo, plus the documented recovery strategy for DPAPI-bound material.
*Fakes:* policy, audit. *Storage:* `broker` schema (capability ledger, revocation epochs).
*Exit:* the capability verification matrix (signature, expiry, use count, fencing token, revocation
epoch, parameter digest, resource); a stale fencing token is rejected; a secret value never appears in
any contract, log, metric, artifact, or audit payload; emergency deny propagates at p95 < 10 s.

**Review gate.** S5 is security-critical. It requires an independent review before it is consumed by
any package that performs a real mutation, and it is not merged on a single session's judgment.

### S6 — Cognition Gateway ●
Context builder (the seven sections, field allow-lists, size limits, data-class and provider policy,
secret detectors, provenance labels), the nine-step routing algorithm, provider adapters
(`generate_structured`, `stream_text`, `realtime_session`, `embed`, `cancel`), structured-output
validation, budget reservation and reconciliation, and the privacy-aware audit record.
*Fakes:* memory, policy, audit. *Storage:* `cognition` schema (budget reservations, route health).
*Exit:* a forbidden provider fails closed and never silently falls back to a weaker data policy; schema
validation failure returns a typed error rather than prose; fallback meets the same capability and eval
floor; budget exhaustion pauses rather than overruns; the injection corpus from S19 runs green at the
agreed threshold. The gateway returns no authorization field of any kind.

### S7 — Connector Broker
The typed adapter contract — `execute`, `lookup` / `reconcile`, and `compensate` where possible — plus
the `agentdev.action.v2` lifecycle (`prepared → sent → succeeded | failed | outcome_unknown`),
idempotency keys, and capability verification on every call. GitHub, Jira, and Slack adapters.
*Fakes:* broker, policy, audit; recorded HTTP fixtures for each provider. *Storage:* `actions` schema.
*Exit:* an ambiguous timeout sets `outcome_unknown` and **automatic retry is refused** until
reconciliation says absent; replay produces no duplicate PR, comment, or transition; compensation
behaves per action class; a parameter mismatch against the capability digest is rejected.

### S8 — Audit and Telemetry
Append-only audit writer with a verifiable hash chain, WORM export interface, schema-driven redaction,
OpenTelemetry conventions, a bounded-cardinality metric registry, dashboards-as-code, and alert rules.
*Fakes:* none meaningful. *Storage:* `audit` schema plus export target.
*Exit:* no secret-class field is persistable by construction; the hash chain detects tampering; ticket
IDs, prompts, filenames, and people never become metric labels; sampling retains 100% of A3, security,
policy, and emergency events.

### S9 — Evidence and Artifact Store
Content-addressed encrypted artifact store (filesystem and S3-compatible implementations), retention
and lifecycle, log hashing, and assembly plus signing of the immutable `agentdev.evidence.v2` bundle
with supersession instead of mutation.
*Fakes:* audit. *Storage:* `evidence` schema plus object store.
*Exit:* the delivery gate rejects an incomplete bundle; digests are stable across re-assembly;
correction produces a superseding bundle and leaves the original intact; retention expiry and the
artifact scan hook both fire.

### S10 — Workspace and Sandbox Manager ● *(gated: isolation spike)*
Fresh workspace per `(workflow, attempt)`, verified and pinned worker images, deny-by-default network
with explicit allow-list, minimal mounts, CPU/memory/disk/time/spend limits, egress logging, teardown,
and the quarantine path.
*Fakes:* broker, audit. *Storage:* `workspace` schema.
*Exit:* the escape suite — host socket, vault, cloud metadata, LAN, other workspaces, presence desktop
— fails to reach anything; quotas terminate rather than degrade; teardown completes after a worker
crash; a fenced worker loses its publish capability.

**Gate.** Blocked on delivery-plan Stage-0 spike 2. The **interface** can and should be authored during
Wave 0 so S11 is not blocked; only the isolation implementation waits.

### S11 — Task Executor and Tool Runner ●
Plan-step execution, tool runner with executable and argument allow-lists, working-directory and
environment allow-list, timeouts, output caps, streaming bounded logs, checkpoints at deterministic
milestones, cancellation tokens, and the coding-adapter interface.
*Fakes:* workspace, cognition, broker, connectors. *Storage:* none durable beyond checkpoints.
*Exit:* a malicious ticket, source comment, or test output attempting tool escalation is contained;
budget exhaustion and cancellation both stop cleanly; a base-SHA change mid-execution returns to
planning rather than improvising; tool output is treated as untrusted and size-bounded.

### S12 — Verifier and Definition of Done ●
Verifier manifest parser and validator (versioned), independent check execution against the immutable
diff and commit, explicit recording of skipped and unavailable checks, verdict plus limitations, and
the diff, secret, and licence scanning hooks. Receives goal, diff, definition of done, and evidence —
never the executor's narrative — and holds no publish capability.
*Fakes:* workspace, evidence. *Storage:* none durable.
*Exit:* executor-says-pass while verifier fails resolves as fail; "skipped" is never reported as pass;
a manifest version mismatch fails closed; the verifier cannot publish or approve.

### S13 — Memory Service core
Record classes, the eight-step ingestion pipeline (eligibility, normalize, quarantine, classify, store
source, derive, validate, index), policy-filter-first retrieval with citations and uncertainty,
tombstone and supersession propagation, the warm-set builder with expiry, and ACL/TTL enforcement.
Built against a `MemoryStore` interface with a SQLite reference implementation, which is what removes
the Ditto spike from this package's critical path.
*Fakes:* cognition (for reflection), policy, audit. *Storage:* `memory` schema.
*Exit:* poison instructions in ticket, source, transcript, tool output, and synced record are
quarantined; a repeated unsupported claim does not gain authority; correction and deletion traverse
records, embeddings, summaries, warm sets, and indexes; cross-tenant and cross-agent ACL isolation
holds; retrieval returns contradictions with dates and status rather than picking one.

### S14 — Ditto storage adapter *(gated: Ditto spike)*
Implements `MemoryStore` over Ditto: collection separation for private, team-approved, and sync
metadata; subscription scope; conflict and tombstone behaviour; peer authentication.
*Exit:* passes the **same** `MemoryStore` conformance suite as the SQLite reference implementation,
plus partial-subscription and concurrent-update tests. Ditto is never used for work claims, approval
uniqueness, fencing, or revocation.

### S15 — Presence Service *(gated: meeting platform)*
Meeting lifecycle FSM, authorization and consent preflight, disclosure, voice provider adapter,
turn-taking (platform events, VAD, address detection, interruption), the grounded-response gate, the
transcript and retention policy, and every row of the failure-behaviour table.
*Exit:* disclosure and consent variations; interruption, cross-talk, echo, reconnect, duplicate audio;
a stale warm-up bundle is refreshed or declared stale rather than spoken; a malicious spoken request for
a privileged tool becomes an ordinary Core decision request and cannot execute in the voice session;
operator takeover and emergency leave.

### S16 — Presentation Controller ● *(gated: Windows spike)*
The interactive companion: the verb and annotation vocabulary, the adapter hierarchy (product API →
Playwright → UIA/FlaUI → OCR → coordinates), postcondition checks, the safe-share preflight, the
non-interactive overlay, and a local emergency stop that works without network.
*Exit:* app upgrade, scaling, localization, and target-window change; a notification or secret popup
during share stops the share first; a stale commit or wrong environment is caught by preflight;
locator ambiguity falls back to the approved static artifact.

### S17 — Windows Supervisor ● *(gated: Windows spike)*
The session-0 service: health, update, session discovery, companion lifecycle, emergency containment,
and the mutually authenticated ACL-restricted IPC endpoint. Never exposes a privileged UI and never
accepts unauthenticated IPC.
*Exit:* survives reboot, logoff, lock, and reconnect; IPC ACLs hold against an unauthorized local
caller; the companion runs non-administrator; containment works with the control plane unreachable.

### S18 — Operator Control and Emergency Stop
The operator API and CLI: pause agent, deny new work and new capabilities, cancel workflow, revoke
tokens, quarantine worker, and the containment verification report. Out-of-band authentication with
RBAC and MFA or signed administrative command; a chat command may be an interface but never the
authority. Aggregates the W0-E hooks.
*Exit:* the six-step emergency sequence completes in order; deny propagates at p95 < 10 s; stop works
with the network or control plane degraded; containment is *verified*, not merely requested.

### S19 — Evaluation and Conformance Harness
The conformance runner and fake-parity driver made real; the fault-injection suite; the adversarial
corpus (direct, indirect, encoded, multimodal injection; canary exfiltration through model, URL, DNS,
tool parameter, artifact, log, screenshot, audio); the task-quality benchmark harness; and cost and
latency regression by pinned version.
*Exit:* every package's required tests are expressible in the harness and run in CI; the harness fails
the build on a safety regression rather than reporting it.

**This package should start in Wave 1, not later.** Every exit gate in every other package depends on
it, and building it last means retrofitting evidence for work already declared done.

### S20 — Integration and Vertical Slice
Owns the dev environment, the wiring of real implementations, the Stage-1 demo scenario as an
executable test, and all seam defects. Runs continuously from the moment two Wave-1 packages land.
*Exit:* the nine-step [first vertical-slice acceptance](../01-product/requirements.md#6-first-vertical-slice-acceptance)
passes end to end with no fakes in the path.

---

## 6. Session protocol

### Collision rules

1. **One package, one branch, one session.** Branch `svc/<id>-<name>`.
2. **Never edit outside your `Owns` paths.** CI enforces this; a violation fails the build.
3. **Contracts are read-only after Wave 0.** Additive changes (new optional field, new enum member)
   go through the contract owner as a standalone PR touching only `packages/contracts`. Renames and
   removals require a version bump and are scheduled, never opportunistic.
4. **Shared files have one owner.** Root config, CI workflows, `docker-compose.dev.yml`,
   `packages/contracts`, `packages/testkit`, and this document belong to the Wave 0 / S20 owner.
   Other sessions append to `CONTRACT-REQUESTS.md` instead of editing.
5. **Deepen your fake before your implementation.** A downstream session blocked on your fake is a
   worse outcome than your own service being a day behind.
6. **No cross-service table access.** If you need a peer's data, it goes through the interface.

### Session brief template

Each session starts from a brief of this shape. It is deliberately self-contained — a session should
never need to read another package's source to do its job.

```markdown
You own package S7 — Connector Broker.

Read, in order:
  doc/03-implementation/implementation-plan.md   (§5 S7 brief, §6 protocol)
  doc/02-architecture/contracts-and-data.md      (§6 capability, §7 action and idempotency, §11 errors)
  doc/02-architecture/components/task-engine.md  (external mutations and recovery)
  packages/contracts/                            (the schemas — read-only to you)

You own:    services/connectors/**   and the `actions` Postgres schema
You may not touch:   anything else. CI will reject it.

Consume every peer through packages/sdk interfaces, backed by the fakes in
packages/sdk/fakes. Do not import another service's source.

Done when:
  - the S7 exit tests in §5 pass
  - your fake and your implementation both pass the shared conformance suite
  - `pnpm test` is green offline with all peers faked
  - CONTRACT-REQUESTS.md records anything you needed and could not express

Open a PR against main. Do not merge other packages' branches into yours.
```

### Concurrency

| Concurrent sessions | Order |
|---:|---|
| 1 | W0 → S2 → S4 → S5 → S7 → S1 → S9 → S12 → S3 → S20 |
| 4 | W0, then {S2, S4, S7, S8} → {S1, S5, S9, S19} → {S3, S6, S12, S20} → gated work |
| 8–10 | W0, then all of S1–S9 plus S19 at once; S3 and S20 join once four peers have deepened fakes |
| >10 | no additional throughput — contract-request queueing becomes the bottleneck |

Ten concurrent sessions is the practical ceiling for Wave 1. Beyond that, sessions spend more time
waiting on contract changes than building.

---

## 7. Gates, risks, and honest limitations

**Four packages cannot start today.** S10 and S11 wait on the sandbox isolation spike; S16 and S17 wait
on the Windows supervisor/companion spike; S14 waits on the Ditto spike; S15 waits on a meeting-platform
decision that has not been made. [delivery-plan.md](../04-delivery/delivery-plan.md#stage-0--decisions-and-spikes-roughly-12-weeks)
is explicit that a failed spike changes architecture before product work, so building these blind risks
rework rather than saving time. Their **interfaces** should still be authored in Wave 0 so nothing
downstream is blocked.

**Sixteen packages can start immediately** once Wave 0 lands: S1–S9, S12, S13, S18, S19, S20, and the
interface halves of S10 and S15.

**Security-critical packages are not ordinary parallel work.** S4, S5, and S10 carry the invariants that
the rest of the architecture assumes. They need an independent review gate before any package performs a
real mutation against them, and they should not be merged on one session's judgment.

**S3 and S20 are the integration risk.** Agent Core touches every interface, and integration defects
surface there first. Pairing their ownership is a deliberate choice, not an oversight.

**Parallelism has a real cost.** The contract freeze is what makes this work, and a frozen contract is
by definition sometimes wrong. Expect a scheduled contract revision between waves and budget for it
rather than letting sessions patch around it locally.

**This plan does not shorten Stage 0.** It parallelizes construction, not decision-making. The ten
go/no-go questions in [delivery-plan.md](../04-delivery/delivery-plan.md#gono-go-questions) remain unanswered, and no
amount of concurrent implementation substitutes for answering them.
