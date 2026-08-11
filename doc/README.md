# Agent Dev — documentation map

This repository is a **design package**, not a working implementation.

![Agent Dev architecture](02-architecture/agent-dev-architecture-v2.png)

[Open the full-resolution architecture image](02-architecture/agent-dev-architecture-v2.png).

## How this documentation is organized

Documents are grouped by **the question they answer** and **what makes them change**. Every document
belongs to exactly one tier. When adding a document, pick the tier by asking which question it answers —
not which project phase produced it.

| Tier | Question it answers | Changes when | Primary audience |
|---|---|---|---|
| [01-product](01-product/) | What are we building, and why? | scope, autonomy, or policy boundaries change | product, stakeholders |
| [02-architecture](02-architecture/) | How is it structured, and what must always hold? | structure, contracts, or invariants change | engineers, security |
| [03-implementation](03-implementation/) | How do we build it, and who builds what? | team shape or package layout changes | implementers |
| [04-delivery](04-delivery/) | In what order do we retire risk? | a stage completes or a gate fails | delivery lead |
| [05-operations](05-operations/) | How do we run, measure, and recover it? | SLOs, runbooks, or telemetry change | on-call, operations |
| [06-decisions](06-decisions/) | Why did we choose this, and what constrains us? | append-only, as facts are learned | everyone |

Architecture describes the system **as it must be**. Implementation describes the **work packages** that
build it. Delivery describes the **order** in which risk is retired. Those are three different lifetimes
with three different owners, so they are three tiers rather than one folder. A change to the delivery
sequence must not require touching an architecture document, and vice versa.

## Contents

### 01 — Product
| Document | Purpose |
|---|---|
| [Requirements](01-product/requirements.md) | Product statement, stakeholders, autonomy levels A0–A4, functional and quality requirements, first vertical-slice acceptance |
| [Original idea](01-product/primary_messy_design.md) | The unmodified product origin. Explains intent; it is not an executable security or operations specification |

### 02 — Architecture
| Document | Purpose |
|---|---|
| [Architecture v2](02-architecture/architecture-v2.md) | Canonical system architecture, planes, invariants, autonomy model, deployment profiles |
| [Component index](02-architecture/README.md) | Component map and the service ownership table |
| [Contracts and data](02-architecture/contracts-and-data.md) | Normative event, workflow, plan, policy, approval, capability, action, memory, and evidence schemas |
| [Security and credentials](02-architecture/security-and-credentials.md) | Threat model, trust boundaries, capability architecture, prompt injection, emergency controls |
| [Secure Box and supervision](02-architecture/secure-box-and-supervision.md) | Trust zones, Windows session architecture, worker lifecycle, supervision, recovery semantics |

### 03 — Implementation
| Document | Purpose |
|---|---|
| [Implementation plan](03-implementation/implementation-plan.md) | 21 independently buildable packages, the contract freeze, fake-parity rule, and the session protocol for parallel work |
| [Development process](03-implementation/development-process.md) | How work moves: every state, the five queues and who owns each, the agent and human loops, and what is actually enforced versus convention |

### 04 — Delivery
| Document | Purpose |
|---|---|
| [Delivery plan](04-delivery/delivery-plan.md) | Risk-first vertical slices, stage gates, demo scope, deferred scope, go/no-go questions |

### 05 — Operations
| Document | Purpose |
|---|---|
| [Operations and evaluation](05-operations/operations-and-evaluation.md) | SLOs, telemetry, runbooks, backup and DR, evaluation layers, release and autonomy gates |

### 06 — Decisions and reference
| Document | Purpose |
|---|---|
| [Review findings](06-decisions/review-findings.md) | Candid P0/P1/P2 critique of the original idea and the former v1 architecture, with dispositions |
| [External constraints](06-decisions/external-constraints.md) | Vendor facts that materially changed the architecture, with sources and a recheck rule |

## Reading paths

- **New to the project:** [requirements](01-product/requirements.md) → [architecture v2](02-architecture/architecture-v2.md) → [review findings](06-decisions/review-findings.md).
- **About to write code:** [architecture v2](02-architecture/architecture-v2.md) → [contracts](02-architecture/contracts-and-data.md) → [implementation plan](03-implementation/implementation-plan.md) → your component doc.
- **Security review:** [security](02-architecture/security-and-credentials.md) → [secure box](02-architecture/secure-box-and-supervision.md) → [contracts](02-architecture/contracts-and-data.md) → [operations](05-operations/operations-and-evaluation.md).
- **Planning or scheduling:** [delivery plan](04-delivery/delivery-plan.md) → [implementation plan](03-implementation/implementation-plan.md) §7 gates.

## Normative hierarchy

If documents conflict, resolve in this order:

1. legal, security, privacy, and organization policy;
2. [requirements](01-product/requirements.md) invariants;
3. [architecture v2](02-architecture/architecture-v2.md);
4. [contracts and data](02-architecture/contracts-and-data.md);
5. component documents;
6. implementation, delivery, and operations documents;
7. examples and technology suggestions.

The original idea explains intent but does not override any of the above.

## Status

- Product idea: captured.
- Architecture: proposed v2; decisions marked **proposed** still need stakeholder validation.
- Implementation: not present in this repository; the plan exists, no code has been written.
- Security certification or production readiness: not claimed.

## Reading rule

Normative statements use **MUST**, **SHOULD**, and **MAY**. Claims such as "never dies," "zero leaks,"
or "fully autonomous" are not guarantees unless they have a measurable SLO, an enforcement mechanism,
and a test.
