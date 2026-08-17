# Platform infrastructure dependency requirements

**Parent:** [Agent Dev requirements](../../requirements.md)

## Secrets manager and token issuer

- **PID-01:** An approved secrets manager and workload identity mechanism are mandatory.
- **PID-02:** The service MUST support audit, rotation, revocation, least-privilege retrieval, and
  preferably short-lived token exchange.
- **PID-03:** Secret-manager administrator authority MUST remain outside Agent Dev task authority.

## Durable transactional store

- **PID-04:** Identity, workflow, policy, approval, and memory metadata require a durable transactional
  store.
- **PID-05:** The store MUST provide encryption, transactions, versioned migrations, point-in-time or
  equivalent recovery, backup, and tested restore.
- **PID-06:** Each canonical entity has one authoritative writer; other services use contracts or
  rebuildable projections.

## Durable event transport

- **PID-07:** The platform MUST provide durable event transport unless an embedded implementation
  proves equivalent safety.
- **PID-08:** It MUST support at-least-once delivery, consumer groups, backpressure, replay,
  dead-letter handling, retention, and observable lag.
- **PID-09:** Consumers MUST be idempotent and tolerate replay after recovery.

## Evidence object store

- **PID-10:** Verification evidence requires immutable or write-once objects, encryption, ACL,
  retention, stable references, and integrity hashes.
- **PID-11:** Evidence deletion and legal hold MUST follow the source data class without breaking
  audit references.
- **PID-12:** Backup and restore MUST preserve object identity and hashes.

## Telemetry stack

- **PID-13:** The stack MUST accept metrics, traces, structured logs, and alerts with pre-persistence
  redaction.
- **PID-14:** Access MUST be separated by environment, project, role, and data class.
- **PID-15:** Telemetry loss MUST be observable; required audit loss fails mutations closed.
- **PID-16:** Retention, export, and deletion MUST follow audit and privacy policy.

## Consumers

- [Supervisor and lifecycle](../services/supervisor-lifecycle.md)
- [Workflow orchestration](../services/workflow-orchestration.md)
- [Capability and credential broker](../services/capability-credential-broker.md)
- [Verification and evidence](../services/verification-evidence.md)
- [Audit and telemetry](../services/audit-telemetry.md)
