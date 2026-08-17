# Verification and evidence service requirements

**Code:** VER  
**Owns:** checks, verdicts, evidence manifests, screenshots, and immutable delivery proof  
**Direct dependencies:** EXE, CON, AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Decide whether work satisfies its definition of done and preserve reproducible proof.

## Requirements

- **VER-01:** Derive checks from task and repository definitions of done.
- **VER-02:** Record procedure, environment, versions, time, exit status, relevant output, and hashes.
- **VER-03:** Verdicts are pass, fail, or inconclusive; missing, cancelled, stale, and unavailable are
  never pass.
- **VER-04:** Distinguish agent-produced claims from independently observed results.
- **VER-05:** Delivery bundles include task, plan, revision, checks, verdict, limitations, rollback,
  and update confirmations.
- **VER-06:** Screenshots identify application and time and pass sensitive-content checks.
- **VER-07:** Evidence is immutable, access-controlled, retention-bound, and stably addressable.
- **VER-08:** Record reviewer identity and independence; no protected self-approval.
- **VER-09:** Completion cites evidence from the delivered revision.

## Acceptance

A code change after testing invalidates the verdict, and incomplete checks block completion.

## Related requirements

- [Secure workspace and task executor](./secure-task-executor.md)
- [Connector and tool gateway](./connector-tool-gateway.md)
- [Platform infrastructure dependencies](../dependencies/platform-infrastructure.md)
