# Agent Core — durable logical identity and coordinator

**Status:** proposed v2  
**Related:** [Architecture](../first_high_level_architecture.md) · [Contracts](contracts-and-data.md) ·
[Task Engine](task-engine.md) · [Cognition](cognition-router.md) · [Memory](memory-service.md)

## Responsibilities

- Represent one stable agent identity and its assigned role, owner, policy, budgets, and capabilities.
- Turn authenticated events into bounded workflows.
- Prioritize, schedule, pause, cancel, and resume activities without resource collisions.
- Request cognition, memory, policy, approval, execution, presence, and broker services through typed
  contracts.
- Keep user-facing claims grounded in source state and evidence.

The Core does not own credentials, execute arbitrary repository code, decide policy, or use memory as
workflow state.

## Identity

Identity is a versioned record, not an unrestricted persona prompt:

```yaml
agent_id: agt_kai_backend
display_name: Kai
disclosure: "AI software-engineering teammate"
owner_group: team-x
role: backend-developer
skills: [python, postgres, incident-analysis]
communication_profile: concise-and-evidence-first
policy_set: engineering-pilot-v2
data_policy: internal-source-code-allowed-providers-a-b
autonomy_ceiling: A2
working_schedule: Europe/Berlin:09:00-18:00
version: 7
```

Persona affects tone, meeting style, and work preferences. Policy, engineering standards, source
evidence, and safety constraints are separate structured inputs and always take precedence. Stable
identity means consistent attribution and behavior—not fabricated humanity.

## Event lifecycle

1. **Ingress** verifies signature/authentication, size and schema limits, source timestamp, and replay
   protection.
2. **Normalization** maps vendor-specific payloads into the canonical event envelope.
3. **Deduplication** uses `(tenant, source, source_event_id)` before a workflow is created.
4. **Eligibility** checks ownership, agent schedule, queue pressure, supported workflow type, and policy.
5. **Triage** produces a structured priority, skills match, risk, data class, and unknowns.
6. **Workflow creation** records definition of done and an immutable input snapshot/reference.
7. **Scheduling** acquires a lease and required resource locks before dispatch.

Untrusted source content is kept in explicitly marked data fields. It never changes system
instructions or grants tools.

## Durable workflow, not an in-memory life loop

The intuitive loop remains observe → interpret → propose → authorize → execute → verify → deliver →
reflect, but each boundary is a persisted state transition. The operational database is authoritative.
An in-process event loop can optimize active work but can always be rebuilt from durable state.

Each transition includes:

- expected workflow version (compare-and-set);
- lease owner, expiry, and fencing token where applicable;
- actor, reason, policy decision, and action ID;
- checkpoint/evidence references; and
- next wake-up time or blocking dependency.

The Core cannot infer “safe to retry” from a missing response. It asks the relevant adapter to
reconcile by idempotency key or remote resource ID.

## Concurrency and arbitration

Parallel activity is supported through named resources and priorities, not unconstrained async tasks.

| Resource | Default cardinality | Rule |
|---|---:|---|
| agent attention | 2 | one interactive + one bounded background task |
| microphone/speaking | 1 | presence owns while in meeting |
| presentation desktop | 1 | exclusive for join/share/walkthrough |
| repo branch/worktree | 1 writer | readers allowed only on immutable commit |
| ticket mutation | 1 per ticket | serialized by workflow version |
| cost budget | configured | reserved before model/tool use |
| production capability | 0 pilot | cannot be acquired |

Priority order: emergency stop/operator takeover → active meeting response → authorized incident
observation → deadline task → normal task → reflection/maintenance. Preemption is cooperative unless a
security action fences the worker. A preempted workflow reaches a safe checkpoint and releases locks.

## Decision records

For every proposed action the Core creates a `DecisionRequest` containing original goal, plan step,
action, normalized parameters, resource, environment, data class, autonomy level, expected effect,
rollback/compensation, budget, and evidence requirement. The policy service returns allow, deny, or
require-approval. The model never emits an “approved” flag that the Core trusts.

## Status communication

Status is derived from workflow truth:

- “working” requires an active lease and recent heartbeat;
- “blocked” names the dependency and next action;
- “tests passed” cites verifier evidence for a commit SHA;
- “done” requires the terminal transition and delivery confirmation;
- degraded provider/tool state is disclosed rather than hidden by persona.

The Core rate-limits and coalesces updates so autonomy does not become channel spam.

## Recovery

On restart the Core:

1. reloads identity/policy versions;
2. scans non-terminal workflows;
3. waits for or fences expired leases;
4. reconciles any `outcome_unknown` external actions;
5. validates workspace/artifact references;
6. resumes at the next safe state or asks for human input.

It never blindly replays shell/model calls from a journal. Checkpoint contents are minimized, encrypted
by data class, and stripped of secret values.

## Interfaces

- In: `CanonicalEvent`, operator commands, workflow wake-ups, presence events.
- Out: `DecisionRequest`, `CognitionRequest`, `ExecutionCommand`, `MemoryQuery/Write`,
  `PresenceCommand`, authenticated agent-to-agent handoff events, status messages.
- State: workflow/lease/lock records in the operational store; identity and policy by immutable version.

Normative shapes are in [contracts-and-data.md](contracts-and-data.md).

## Required tests

- duplicate webhook and out-of-order event;
- two agents claiming one ticket;
- crash before, during, and after an external mutation;
- expired worker attempting a fenced write;
- operator pause/stop during model call, test run, delivery, and meeting;
- concurrent meeting plus background task resource arbitration;
- false completion claim rejected when evidence is missing.

## Open decisions

- Durable workflow implementation after the idempotency spike.
- Per-agent and per-tenant concurrency/budget defaults.
- Whether scheduling is fleet-central or tenant-local in the pilot.
