# Architecture — component index

**Status:** architecture v2, proposed; no implementation is present.
**Canonical document:** [Architecture v2](architecture-v2.md)
**Documentation map:** [../README.md](../README.md)

This tier answers *how the system is structured and what must always hold*. It does not describe build
order (see [delivery](../04-delivery/delivery-plan.md)) or who builds what (see
[implementation](../03-implementation/implementation-plan.md)).

## Cross-cutting documents

These describe boundaries and rules that span every component, so they live at this level rather than
under `components/`.

| Document | Purpose |
|---|---|
| [Architecture v2](architecture-v2.md) | Planes, invariants, autonomy model, cognition routing, deployment profiles, technology posture |
| [Contracts and data](contracts-and-data.md) | Normative envelope, workflow state machine, plan, policy, approval, capability, action, memory, and evidence schemas |
| [Security and credentials](security-and-credentials.md) | Threat model, trust boundaries, data classification, capability architecture, injection defense, emergency controls |
| [Secure Box and supervision](secure-box-and-supervision.md) | Runtime trust zones, Windows session architecture, task worker lifecycle, supervision hierarchy, recovery semantics |

## Components

| Document | Owns |
|---|---|
| [Agent Core](components/agent-core.md) | Durable logical identity, event lifecycle, scheduling, concurrency arbitration, decision records, recovery |
| [Cognition Gateway](components/cognition-router.md) | Context construction, model routing, provider adapters, budgets, response validation |
| [Task Engine](components/task-engine.md) | Isolated execution, definition of done, verification, delivery, PR review, incident workflows |
| [Memory Service](components/memory-service.md) | Tiered provenance-aware learning, ingestion, retrieval, retention, correction and deletion |
| [Presence Service](components/presence-service.md) | Disclosed meeting participation, voice, turn-taking, consent, grounded responses |
| [Presentation Controller](components/simulation-service.md) | Safe screen walkthroughs, verb vocabulary, safe-share preflight, annotation overlay |

The file names `cognition-router.md` and `simulation-service.md` are retained deliberately: each document
records its former name as a product alias.

## Service ownership map

Exactly one component is authoritative for each concern. Anything else holding that state is a cache or
a projection, never the source of truth.

| Concern | Authoritative owner |
|---|---|
| Work status, retries, timers, leases | Workflow engine / operational store |
| Permission to act | Policy and approval service |
| Secret retrieval and token minting | Capability/credential broker |
| Model choice and context | Cognition gateway |
| Repository code execution | Ephemeral task worker |
| Task completion verdict | Independent verifier + definition of done |
| Learned knowledge | Memory service |
| Raw artifacts | Encrypted object store |
| Meeting behavior and transcript | Presence service |
| UI navigation and screen-share safety | Presentation controller |
| Forensic truth | Append-only audit service |

## Normative hierarchy

Within this tier, [architecture v2](architecture-v2.md) outranks [contracts](contracts-and-data.md),
which outrank component documents, which outrank examples and technology suggestions. The full
cross-tier order is in the [documentation map](../README.md#normative-hierarchy).
