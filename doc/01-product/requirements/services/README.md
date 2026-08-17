# Service requirements

This directory contains one normative requirements document for each logical Agent Dev service.
Service boundaries define ownership and contracts; they do not require one separately deployed
microservice per file.

| Code | Service |
|---|---|
| SUP | [Supervisor and lifecycle](./supervisor-lifecycle.md) |
| IDN | [Identity, role, and persona](./identity-role-persona.md) |
| ING | [Ingress and normalization](./ingress-normalization.md) |
| WFE | [Workflow and task orchestration](./workflow-orchestration.md) |
| COR | [Agent core and planner](./agent-core-planner.md) |
| CGW | [Cognition and model gateway](./cognition-model-gateway.md) |
| POL | [Policy, risk, and approval](./policy-risk-approval.md) |
| CAP | [Capability and credential broker](./capability-credential-broker.md) |
| CON | [Connector and tool gateway](./connector-tool-gateway.md) |
| EXE | [Secure workspace and task executor](./secure-task-executor.md) |
| VER | [Verification and evidence](./verification-evidence.md) |
| MEM | [Memory and learning](./memory-learning.md) |
| PRE | [Presence and real-time communication](./presence-realtime.md) |
| SIM | [Presentation and UI simulation](./presentation-ui-simulation.md) |
| COL | [Collaboration and delivery](./collaboration-delivery.md) |
| AUD | [Audit and telemetry](./audit-telemetry.md) |
| OPC | [Operator control](./operator-control.md) |

All services are also governed by the
[master product requirements](../../requirements.md) and the
[dependency requirements](../dependencies/README.md).
