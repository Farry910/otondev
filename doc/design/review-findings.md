# Deep review findings

**Scope:** `primary_messy_design.md` plus the former reconciled v1 documents  
**Method:** requirements trace, failure-mode analysis, trust-boundary review, lifecycle review, and
vendor-constraint verification  
**Disposition:** findings are addressed in architecture v2 unless marked open

## 1. What is strong in the idea

- It targets a real teammate workflow, not a chat demo: tickets, PRs, incidents, meetings, and KT.
- It correctly separates automation-optimal solo work from visual explanation to humans.
- It recognizes identity, long-lived learning, role specialization, concurrency, evidence, and
  credential safety as first-class product concerns.
- A dedicated environment and local reasoning option create useful control points.
- Warm-up memory before a meeting is a concrete, valuable user experience.

Those are product differentiators worth preserving. The problem is not the ambition; it is that the
former architecture converted aspirations into guarantees without enough mechanisms or scope control.

## 2. P0 findings — unsafe or correctness-blocking

| Finding | Why it fails | V2 disposition |
|---|---|---|
| One “never-die” service | no process survives host, network, storage, bad rollout, or regional failure; a watchdog cannot guarantee continuity | define SLO/RTO/RPO; durable workflow, leases, fencing, replicated recovery |
| Journal stored as memory | task truth and learned context have different consistency, retention, and corruption risks | transactional operational store for workflow; memory is a projection |
| Replay without idempotency | crash after a side effect but before journal write can duplicate comments, PRs, deploys, or tickets | action IDs, source reconciliation, compare-and-set transitions, fenced leases |
| Local SLM as security gate | model classification has false negatives and can be attacked by untrusted content | deterministic data/source policy first; model is advisory; unknown fails restricted |
| Universal redaction proxy | TLS, certificate pinning, QUIC, browsers, WebRTC, SaaS semantics, binaries, and encoded data defeat a simple content proxy | context minimization, typed gateways, network policy, DLP backstop; no zero-leak claim |
| Broad credentials in one box | compromised repo/dependency/test/model/tool can reach the same user/session/vault | brokered short-lived capabilities; task sandbox separated from presence and vault |
| No prompt-injection boundary | tickets, code, logs, PR text, chat, web, and memory can instruct an action-capable model | mark all as untrusted; quarantine parsing; validate actions against original intent/policy |
| Autonomous prod incident fix | logs are ambiguous and blast radius is high; there is no rollback, change window, or command authority | pilot is read-only diagnosis/RCA; A4 remains human-operated |
| Windows service drives UI | modern Windows services run non-interactively/session 0 and cannot directly own the user desktop | non-interactive supervisor plus least-privilege per-session companion over ACLed IPC |
| Approval represented as YAML text | policy syntax alone has no identity, environment, resource, exact-action binding, expiry, or revocation | centralized policy decision and signed/action-digest approval record |

## 3. P1 findings — major reliability, privacy, or product gaps

| Finding | Consequence | V2 disposition |
|---|---|---|
| Scope is fleet + all roles + hard incidents + voice + UI in eight weeks | demo may look broad while core correctness is unproven | risk-first vertical slices; second agent and incident last |
| Per-agent VM is both identity, worker, vault, and desktop | high cost, contention, weak isolation, poor scaling | logical identity + disposable task workers + persistent minimal presence desktop |
| Async tasks are called a concurrency model | races over branch, screen, mic, meeting state, memory, and budgets | named resource locks, priorities, cancellation, work leases, separate workspaces |
| “Every event” becomes memory | privacy overcollection, poisoning, unbounded cost, stale personal profiles | eligibility/consent/TTL/ACL/provenance; source vs derived records; deletion propagation |
| Reflection can rewrite knowledge | model hallucinations become durable organizational facts | derived claims cite immutable sources; no source overwrite; confidence/supersession |
| Ditto assumed to solve all durability | causal sync and CRDT merge do not equal a global lock/approval ledger | keep Ditto for local-first memory; operational DB owns leases/approvals |
| Screenshots treated as test proof | screenshots can be stale, forged, or leak data | commit-bound logs, commands, CI artifacts, hashes; minimal redacted visuals only |
| Human-like behavior emphasized over truth | can feel deceptive and wastes effort on cursor cosmetics | explicit AI disclosure; semantic UI control and clear annotation first |
| Meeting consent absent | recording/transcription/privacy and platform policy risk | disclosure, consent, retention, mute/leave/takeover, safe-share preflight |
| Kill switch is a chat command “any human” can use | spoofing, denial of service, unclear auth; VM pause does not revoke tokens | RBAC/MFA or signed command, deny new capabilities, revoke, fence, then contain |
| No fleet control plane | claim races, cost runaway, version drift, duplicate work | scheduler, policy/approval, identity, capability broker, audit/observability |
| No definition of done | model can declare success after weak or irrelevant tests | repository-owned verifier contract and evidence bundle |
| No independent verification | executor grades its own work | separate verifier context/process; protected-branch human approval |

## 4. P2 findings — important design quality issues

- Routing only by `role × task` is too coarse; include risk, data class, measured capability,
  provider policy, context size, latency, availability, and cost.
- Model/vendor names in architecture will age quickly; use provider adapters and versioned routing.
- “Identity in every prompt” can bias technical judgment and waste context. Persona belongs mainly in
  communication; engineering standards and policy belong in structured context.
- Auto-logon and an always-open desktop conflict with strong local secret protection. The presence
  desktop should have minimal credentials, screen lock/host controls, and no production secrets.
- Playwright and accessibility/UIA are not interchangeable fallbacks. They need platform-specific
  adapters, semantic locator contracts, and postcondition checks.
- Cross-agent shared `people` memory risks privacy leakage and groupthink. Share approved team facts,
  not private profiles, by default.
- Fixed resolution helps coordinate fallbacks, not AutomationId stability. Coordinates should be a
  last resort.
- “Full audit log of every model call” may itself collect sensitive prompts. Log metadata/hashes and
  retain payloads only under explicit policy.
- Cost, capacity, provider rate limits, data residency, licensing, and meeting platform terms need
  explicit pilot decisions.

## 5. Requirement trace from the original idea

| Original intent | Preserved as | Necessary correction |
|---|---|---|
| alive, independent teammate | durable logical identity and bounded autonomous scheduler | transparent AI; organization owns goals and authority |
| role-specialized models | configurable capability routing | role is one signal, not the primary safety/quality rule |
| several things at once | concurrent activities | locks, priorities, branch isolation, cancellation |
| learn from all experiences | eligibility-based ingestion and source-linked reflection | consent, minimization, poisoning defense, correction/deletion |
| own Windows OS and real screen | dedicated presence desktop | untrusted builds run elsewhere; supervisor/companion session split |
| Jira/tasks/planning/review/incidents | typed task workflows | incremental rollout; prod is read-only in pilot |
| chat and meetings | presence adapters | disclosure, consent, retention, takeover |
| human-like gestures | annotation and presentation vocabulary | clarity before imitation; no deception |
| local pre-reasoning | local model option | not a security boundary |
| Ditto memory | Ditto-backed memory adapter | not lease, approval, or workflow truth |
| critical credentials safe | capability and credential broker | enterprise vault/short-lived tokens; no absolute leak guarantee |
| one big service never dies | continuously available product | durable workflows, SLOs, recovery, redundancy |

## 6. Overall verdict

The concept should proceed only as a narrow, governed engineering workflow first. The differentiating
combination—persistent role, evidence-aware memory, normal team channels, and live explanation—is
strong. The highest business risk is building the visible persona before the invisible control,
security, provenance, and recovery layers. Architecture v2 reverses that order.
