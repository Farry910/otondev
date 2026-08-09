# Delivery plan — risk-first vertical slices

**Status:** proposed; schedule depends on team, integrations, and security environment  
**Related:** [Requirements](requirements.md) · [Operations](operations-and-evaluation.md) ·
[Review](review-findings.md)

## Planning assumptions

Calendar estimates are unsafe until the team, first repository, providers, hosting, ticket/Git/meeting
platforms, Ditto version, and enterprise identity/vault are known. The ranges below assume a small
cross-functional team with access to test tenants and one well-tested repository. They are for
sequencing, not commitment.

The old eight-week scope—multi-agent fleet, all work types, memory, voice, human-like UI, incident
response, and hardening—is not a credible production plan. A controlled demo may fit in that period only
by narrowing to one governed task slice and one safe presence slice.

## Stage 0 — decisions and spikes (roughly 1–2 weeks)

Choose one ticket system, Git forge, chat/meeting platform, repo/language, hosting profile, model data
policy, vault/identity, and Ditto SDK/deployment. Run five kill-or-continue spikes:

1. Windows supervisor + interactive companion survives reboot/logoff/reconnect and controls target app.
2. Task sandbox blocks vault/host/LAN/metadata and still runs target repo tests.
3. One connector implements action ID, reconcile, and duplicate-event behavior.
4. Ditto record/provenance/tombstone/sync/partial-subscription behaviors meet memory needs.
5. Candidate voice path meets latency, interruption, data, and cost thresholds.

Exit: architecture decisions recorded, threat model reviewed, first definition-of-done manifest exists,
and no spike exposes a fundamental blocker. Failed spikes change architecture before product UI work.

## Stage 1 — governed task vertical slice (roughly 3–6 weeks)

Build ingress/dedupe, operational workflow, identity/policy, one cognition adapter, isolated worker,
one repo toolchain, Git/ticket connector, verifier, evidence bundle, audit, operator pause/stop.

Demo: a synthetic ticket produces a draft PR exactly once with commit-bound checks and clear limitations.
Kill the Core/worker at multiple points, replay the webhook, expire the token, and prove correct recovery.

Exit gates are the [first vertical-slice acceptance](requirements.md#6-first-vertical-slice-acceptance),
not a polished persona.

## Stage 2 — memory and learning slice (roughly 2–4 weeks)

Build source/derived record schema, Ditto adapter, L1 warm set, retrieval with citations, reflection as
proposal, feedback scope, correction/deletion, and memory security/eval suite.

Demo: an approved review comment changes a later plan in the correct repo/scope; the response cites the
comment. Then correct/delete it and prove it disappears from warm sets, retrieval, and synced/indexed
projections.

Exit: memory improves the measured task without increasing unsupported claims or violating ACL/TTL.

## Stage 3 — presence and presentation slice (roughly 3–6 weeks)

Build one meeting adapter, disclosure/consent, voice provider adapter, interruption/mute/leave, Windows
companion, safe-share preflight, semantic walkthrough, overlay, operator takeover, transcript policy.

Demo: the disclosed agent joins a controlled standup, gives a source-grounded update, answers one
follow-up, and shares only a sanitized PR/evidence window. Inject a UI mismatch and show safe fallback.

Exit: platform test matrix, privacy/adversarial suite, and presence SLO thresholds pass.

## Stage 4 — collaboration and operational pilot (roughly 4–8 weeks)

Add a second logical identity only now. Implement cross-agent work claims, handoff, non-binding PR
review, shared approved memory, fleet budgets/capacity, dashboards, runbooks, backup/restore, canary and
rollbacks.

Demo: agent B reviews immutable agent A output without self-approval; duplicate claims are prevented;
private memory does not cross agents.

Exit: controlled A0–A2 pilot with on-call ownership, independent security review, and quality baseline.

## Stage 5 — incident analysis, not autonomous production

Add authenticated alert intake and typed **read-only** log/metric/deploy adapters. Produce a timeline,
hypotheses, suggested mitigations, and RCA draft with confidence/evidence. Test on synthetic incidents.

Production write actions remain human-operated. A later A3 staging mutation program requires exact
approval, rollback, change-management, error budget, and dedicated security/operational review. A4 is a
separate product decision, not the natural next checkbox.

## Recommended first demo

Keep it to 12–15 minutes:

1. show the authenticated ticket and policy/autonomy boundary;
2. agent claims it and creates an isolated workspace;
3. show implementation plus independent verifier/evidence bundle;
4. replay/fault one event and prove no duplicate PR/comment;
5. agent joins a controlled meeting as an explicitly disclosed AI;
6. it gives a grounded update and safely shares the exact commit/check evidence;
7. operator hits stop and the broker/scheduler deny further effects.

This demonstrates autonomy, identity, safety, recovery, evidence, and presence without pretending to
solve fleet negotiation or production incident response.

## Workstreams

| Workstream | Earliest start | Blocks |
|---|---|---|
| product/requirements and UX transparency | Stage 0 | all external behavior |
| threat model, identity, policy, broker | Stage 0 | any real mutation |
| workflow/contracts/connectors | Stage 0 | task slice |
| worker isolation and verifier | Stage 0 | source execution |
| memory/Ditto | after schema spike; parallel with late Stage 1 | memory slice |
| Windows presence/meeting spike | Stage 0; full build after task safety | presence slice |
| evaluation/adversarial/fault suite | starts Stage 0, grows every stage | every exit gate |
| operations/runbooks/DR | begins Stage 1 | pilot |

## Explicitly deferred

- all OSes and dynamic cross-application UI support;
- broad role catalog and role-fine-tuned models;
- autonomous sprint commitment or people assignment;
- autonomous protected-branch merge;
- autonomous production remediation;
- arbitrary cloud/DB admin UI walkthroughs;
- permanent raw audio or “remember everything”;
- rich multi-agent negotiation and hierarchy;
- proof that the agent “never dies” or that leaks are impossible.

## Go/no-go questions

Do not start a real pilot until all are answered:

1. Who owns the agent and can stop it?
2. Which exact A0–A2 actions are allowed in which resources/environments?
3. What data may go to which model/voice provider and region?
4. What is the repository definition of done and hidden-quality baseline?
5. How are credentials minted, scoped, rotated, and revoked?
6. What meeting disclosure/consent/retention policy applies?
7. What does Ditto sync, and how do correction/deletion/conflict rules behave?
8. What SLO, budget, error rate, and human-intervention rate are acceptable?
9. Who is on call and what is the incident/privacy response?
10. What evidence is required before expanding any autonomy class?
