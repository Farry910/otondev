# Agent Dev — Design index

**Status:** architecture v2, proposed; no implementation is present.  
**Canonical parent:** [Architecture v2](../first_high_level_architecture.md)  
**Unmodified product origin:** [primary_messy_design.md](../primary_messy_design.md)

## Core documents

| Document | Purpose |
|---|---|
| [Requirements](requirements.md) | Product boundaries, autonomy levels, functional and quality requirements, acceptance criteria |
| [Review findings](review-findings.md) | Candid P0/P1/P2 critique of the original idea and the former v1 architecture |
| [Agent Core](agent-core.md) | Durable logical identity, event handling, scheduling, workflow coordination, concurrency |
| [Cognition Router](cognition-router.md) | Risk/data/capability routing and model-call governance |
| [Task Engine](task-engine.md) | Isolated execution, verification, delivery, review, and incident workflows |
| [Memory Service](memory-service.md) | Tiered, provenance-aware learning over a Ditto adapter |
| [Presence Service](presence-service.md) | Disclosed live meeting participation, audio, turn-taking, consent |
| [Simulation / Presentation](simulation-service.md) | Safe screen walkthroughs and desktop automation |
| [Security and Credentials](security-and-credentials.md) | Threat model, capabilities, secrets, prompt injection, privacy, emergency stop |
| [Secure Box and Supervision](secure-box-and-supervision.md) | Trust zones, Windows session architecture, sandboxes, recovery |
| [Contracts and Data](contracts-and-data.md) | Normative event, command, policy, approval, workflow, memory, and evidence schemas |
| [Operations and Evaluation](operations-and-evaluation.md) | SLOs, telemetry, runbooks, conformance, adversarial and quality evaluation |
| [Delivery Plan](delivery-plan.md) | Risk-first increments, gates, demo, pilot, and deferred scope |
| [External Constraints](external-constraints.md) | Vendor facts that materially constrain this design |

## Service ownership map

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

If documents conflict, use this order:

1. legal, security, privacy, and organization policy;
2. [requirements.md](requirements.md) invariants;
3. [first_high_level_architecture.md](../first_high_level_architecture.md);
4. [contracts-and-data.md](contracts-and-data.md);
5. component documents;
6. examples and technology suggestions.

The original idea explains intent but is not an executable security or operations specification.
