# Task Engine — governed engineering workflows

**Status:** proposed v2  
**Related:** [Agent Core](agent-core.md) · [Security](security-and-credentials.md) ·
[Contracts](contracts-and-data.md) · [Operations](operations-and-evaluation.md)

## Responsibilities

- Execute typed engineering workflows inside isolated workspaces.
- Use repository-owned definitions of done and independent verification.
- Make external side effects idempotent and policy-authorized.
- Produce evidence-bound delivery, review, planning, and incident outputs.

## Internal services

| Service | Responsibility |
|---|---|
| Workflow adapter | task-type state machine and compensation rules |
| Workspace manager | clean checkout/worktree, sandbox, quotas, teardown |
| Tool runner | allow-listed shell/build/test operations with streaming logs |
| Connector broker | typed ticket/Git/chat/cloud calls using scoped capabilities |
| Executor | plan-step implementation through approved coding adapter |
| Verifier | independent checks against definition of done |
| Evidence builder | commit-bound, hashed metadata and artifact references |
| Delivery adapter | draft PR, ticket transition/comment, team update |

Executor and verifier use separate contexts and SHOULD run in separate processes. The verifier receives
the goal, diff, definition of done, and evidence—not the executor's persuasive narrative.

## Ticket-delivery workflow

1. **Intake:** snapshot ticket fields and source IDs; label untrusted text.
2. **Clarify:** detect missing acceptance criteria, conflicting requirements, or unsupported scope.
3. **Plan:** define intended files, external effects, tests, rollback, data/risk, budget, and limits.
4. **Authorize:** policy allow/deny/approval for the plan and action classes.
5. **Claim:** atomic workflow transition plus ticket/resource lease.
6. **Prepare:** clean base SHA, task branch, isolated workspace, dependency/network policy.
7. **Execute:** bounded steps; checkpoint after deterministic milestones.
8. **Verify:** repository checks plus task-specific checks; scan diff/artifacts/secrets/licenses as policy requires.
9. **Deliver:** push branch, open **draft** PR, add evidence, transition ticket, post one grounded update.
10. **Reflect:** memory receives eligible source events and outcome; workspace is retained briefly then destroyed.

If the base changes materially, policy or definition of done changes, or execution exceeds budget, the
workflow returns to plan/authorization rather than improvising.

## Workspace and command policy

- Each task receives a fresh workspace keyed by workflow and attempt.
- Default network is denied; package registries and required test services are explicit.
- Mounts are minimal. Vault sockets, host Docker sockets, SSH agents, browser profiles, and unrelated
  repos are forbidden.
- Commands have executable/argument policy, working directory, environment allow-list, timeout,
  output cap, and cancellation token.
- Tool output is untrusted, size-bounded, and stored as artifacts when large.
- Generated code is reviewed/scanned like external code; model authorship grants no trust.
- An abandoned/failed worker loses its fencing token and cannot publish.

## Definition of done

Every repository integrated with Agent Dev MUST provide a versioned verifier manifest, for example:

```yaml
version: 3
required:
  - {name: unit, command: "make test-unit", timeout: 900}
  - {name: lint, command: "make lint", timeout: 300}
conditional:
  frontend-change: [{name: ui, command: "make test-ui"}]
evidence:
  retain_logs_days: 14
  screenshots: on_ui_change
forbidden:
  - generated-secrets
  - modified-protected-paths-without-approval
```

The engine records skipped/unavailable checks explicitly. “Best effort” is not equivalent to pass.

## External mutations and recovery

All mutations use a stable `action_id` and adapter reconciliation:

- before call: persist `prepared` with parameter digest and policy decision;
- during call: pass provider-supported idempotency key or deterministic marker;
- after response: persist remote resource/version and outcome;
- on timeout: query by idempotency key/marker before retry;
- if still unknowable: enter `WAITING_INPUT/outcome_unknown`, never guess.

Compensation is action-specific: remove an unsubmitted comment, close a draft PR, revert a ticket
transition, revoke a temporary token. A Git push or external notification is not generically undoable,
so the system records limitations.

## PR review

The agent checks the immutable head SHA, reads the diff and relevant context, runs allowed verification,
and emits comments tagged as blocker/suggestion/question with file/line evidence. It MUST disclose
unrun checks. It MAY submit a non-binding review at A2; protected-branch approval remains human in the
pilot. The agent cannot review its own output as an independent approval.

## Sprint planning

Sprint planning is A1 proposal initially. Estimates include assumptions, uncertainty range, dependency,
and historical provenance. The agent does not commit human capacity, change sprint scope, or assign
people without team policy/approval.

## Incident workflow

Pilot incident capability is deliberately narrow:

1. authenticated alert creates a high-priority **read-only** workflow;
2. fetch allow-listed logs/metrics/deploy metadata through typed read adapters;
3. build timeline and hypotheses with evidence/confidence;
4. propose queries, mitigations, rollback steps, and an RCA draft;
5. a human incident commander operates production.

Synthetic environments may exercise A3 remediation after exact approval. Production mutation (A4)
is out of scope until a separate safety case, rollback automation, change-management integration, and
incident-command protocol exist.

## Evidence bundle

The bundle binds task input version, base/head SHA, diff hash, commands, toolchain/container image,
test verdicts/log hashes, policy/approval IDs, action IDs/URLs, verifier version, known gaps, and artifact
retention. Screenshots are optional supporting artifacts and must pass sensitive-content handling.

## Required tests

- malicious ticket/code/log instruction attempting tool escalation;
- dependency/test trying to access vault, host, network, or other workspace;
- branch/base changes during execution;
- duplicate delivery and ambiguous provider timeout;
- executor says pass while verifier fails;
- cancellation and budget exhaustion;
- own-PR review conflict;
- incident request attempting a production mutation in pilot policy.

## Open decisions

- Initial repo/language and verifier manifest.
- Isolation technology per Windows/Linux workload.
- One initial ticket/Git/chat adapter set.
