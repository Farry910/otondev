# Security, privacy, and credentials

**Status:** proposed threat model; not a certification or achieved guarantee  
**Related:** [Architecture](../first_high_level_architecture.md) · [Requirements](requirements.md) ·
[Secure Box](secure-box-and-supervision.md) · [Cognition](cognition-router.md)

## Security objectives

1. An untrusted input or compromised model cannot grant itself authority.
2. Compromise of a task worker does not expose durable credentials, other tasks, the presence desktop,
   control-plane data, or production.
3. Every A2+ mutation is attributable, authorized, bounded, reconstructable, and revocable where
   possible.
4. Sensitive data sent to a model/provider follows explicit tenant data policy and minimization.
5. Memory and meeting data honor consent, ACL, retention, correction, and deletion.
6. Operators can contain the system without trusting the affected agent/model.

Absolute claims such as “credentials never leak” are replaced by enforced controls, tests, detection,
and incident response.

## Assets

- source code, issues, PRs, logs, customer/production data, architecture and internal hostnames;
- repository, ticket, chat, meeting, cloud, and model-provider credentials;
- workflow/approval/policy state, audit records, memory, transcripts, artifacts;
- agent and human identities, budgets, compute, and organizational reputation;
- availability and integrity of production and team systems.

## Adversaries and failure sources

- malicious ticket author, repo contributor, dependency, website, meeting participant, or synced peer;
- compromised model/provider/tool/connector/browser extension/task process;
- prompt injection, memory poisoning, tool-output forgery, social engineering, and inter-agent spoofing;
- insider misuse or overly broad policy;
- accidental disclosure through logs, screenshots, prompts, clipboard, audio, or screen share;
- stale/ambiguous state, retries, races, expired approvals, and supply-chain compromise.

## Trust boundaries

| Boundary | Data entering | Required control |
|---|---|---|
| external system → ingress | webhook/event payload | signature/auth, replay/dedupe, schema/size limits |
| untrusted content → cognition | text/code/log/image/audio | provenance labels, quarantine, instruction/data separation |
| cognition → action | proposed command | typed schema, intent match, policy, approval, budget |
| control plane → worker | task command/capability | workload identity, lease/fencing, minimal scope/TTL |
| worker → connector | external mutation | brokered token, validation, idempotency, audit |
| worker → artifact/memory | results/claims | scan, hash, source linkage, ACL/TTL |
| presence desktop → meeting | screen/audio | disclosure/consent, safe-share, local stop |
| Ditto peer sync | knowledge changes | peer auth, collection ACL, schema/conflict/tombstone rules |

## Data classification

Minimum classes: `public`, `internal`, `confidential`, `restricted`, and `secret`. Credentials are
always `secret` and are not model context. Unknown data is treated as at least `confidential` until
classified. Provider, region, retention, logging, memory, screen-share, and artifact rules are defined
per class and tenant.

## Capability and credential architecture

The model and task worker use resource handles such as `repo:team/api` and request a typed operation.

```text
model proposal -> Core -> policy/approval -> capability broker -> trusted adapter -> target API
                                      short-lived token/operation, never returned to model
```

- Human/agent/workload identity is authenticated independently.
- A capability binds actor, workflow/action ID, operation, resource, parameter constraints,
  environment, max uses, issue/expiry, and fencing token.
- The broker retrieves or mints a secret only for the trusted adapter.
- Prefer workload identity/OAuth app installations and short-lived tokens over passwords/PATs.
- Token values are never persisted in workflow, prompt, memory, artifact, or audit payload.
- Rotation, revocation, access review, and break-glass paths are documented and tested.

Windows Credential Manager/DPAPI may be used for a controlled demo. It protects secrets at rest under
a Windows security context, but an allowed process under that context may still request decryption;
auto-logon and a shared interactive user weaken the practical boundary. Production uses a separate
enterprise vault/broker and a recovery plan for DPAPI-bound material.

## Prompt injection and confused deputy defense

Every external/retrieved content field is data, even if it says “system,” “admin,” or “approved.”
Controls:

- no-tools parser/summarizer for high-risk content;
- preserve original user/team goal separately from retrieved content;
- structural delimiting, encoding normalization, active-content stripping, and size limits;
- action validator compares proposed effect/parameters to original goal and policy;
- typed tools with allow-listed resources and strict parameter schemas;
- human approval for elevated operations, bound to exact action digest;
- restricted egress and read-only credentials where possible;
- memory provenance and quarantine prevent persistent injected instructions becoming policy;
- adversarial tests run after changes to prompts, models, tools, memory, or policies.

No LLM classifier or sanitizer is trusted as the only defense.

## Egress and redaction

A cognition/API gateway, DNS/network allow-list, and outbound DLP provide layered control. A universal
transparent “Redaction Proxy” is not sufficient because encrypted/protocol-specific/browser/WebRTC
traffic may not be inspectable or safely rewritten. The preferred controls are:

1. do not fetch secrets into agent/model context;
2. construct outbound payloads from allow-listed fields;
3. route through typed provider/connector adapters;
4. block unknown destinations and direct worker internet access;
5. scan supported outbound payloads and artifacts as backstop;
6. alert/quarantine on canary or policy violation.

Audit logs prove what controls observed, not that no leakage was mathematically possible.

## Sandbox and supply chain

- untrusted builds/tests run in disposable workers separated from control/presence/vault;
- deny host sockets, device access, unrelated mounts, cloud metadata, LAN, and unrestricted egress;
- pin/verify worker images and critical dependencies; retain software/component inventory;
- enforce resource/time/output limits and malware/secret scanning;
- sign releases and configuration/prompt/model-policy bundles;
- treat successful sandbox escape as a security incident and rotate affected credentials.

## Privacy and meeting safety

- clearly disclose AI identity and recording/transcription status;
- minimize attendee/profile data and avoid inferred sensitive traits;
- raw audio off by default; transcript and summary follow consent and TTL;
- screen-share only a selected sanitized window; notifications and unrelated apps are closed;
- provide access/correction/deletion mechanisms and legal-hold semantics;
- apply tenant and subject ACL before retrieval or fleet sharing.

## Emergency controls

Emergency stop is an out-of-band control with RBAC/MFA or signed administrative command. It performs:

1. set tenant/agent deny-new-work and deny-new-capabilities;
2. revoke outstanding capability/token sessions where supported;
3. fence active leases so workers cannot commit/publish;
4. cancel model/tool/presence activity and stop screen/audio;
5. quarantine workers/desktops as necessary;
6. preserve minimal forensic evidence and notify the operator.

A local hardware/console stop on the presence desktop must work without network. A chat command can be
an interface, but not the authority by itself.

## Audit design

Log actor/workload, action/resource/environment, workflow and action IDs, policy/approval decision,
parameter digest, external resource ID, result, time, model/tool/config versions, and evidence hashes.
Do not log raw tokens or default full prompts/transcripts. Export high-value events to append-only/WORM
storage with access monitoring and retention.

## Security gates

- threat model reviewed for each new connector/action class;
- zero unauthorized actions and cross-tenant reads in tests;
- prompt/memory/tool injection suite passes;
- sandbox escape/credential exfiltration exercise passes to agreed threshold;
- secret/canary, artifact, screenshot, and log scans pass;
- stop/revoke/fence tested under network and control-plane failure;
- dependency/image/policy/prompt changes are versioned and rollback-tested;
- independent security review before real production data or A3 expansion.

## Open decisions

- Customer data classification and provider agreements/residency.
- Enterprise identity/vault and token-broker integrations.
- Sandbox boundary acceptable for each workload language/OS.
- Audit retention, WORM target, privacy access, and incident-response owner.
