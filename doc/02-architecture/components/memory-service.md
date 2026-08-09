# Memory Service — provenance-aware learning over Ditto

**Status:** proposed v2  
**Related:** [Security](../security-and-credentials.md) · [Contracts](../contracts-and-data.md) ·
[Presence](presence-service.md) · [External constraints](../../06-decisions/external-constraints.md)

## Responsibilities

- Provide fast, relevant, source-linked context for tasks and meetings.
- Preserve raw/source facts separately from model-derived claims.
- Learn from eligible tasks, feedback, onboarding, KT, and meetings.
- Enforce consent, data class, ACL, retention, correction, deletion, and sync scope.
- Resist memory poisoning, staleness, contradiction, and cross-agent privacy leakage.

Memory is not the workflow engine, approval ledger, credential store, or audit authority.

## Memory hierarchy

| Tier | Purpose | Storage | Typical lifetime |
|---|---|---|---|
| L0 active context | current bounded model/session context | process/provider session | minutes |
| L1 warm set | precomputed facts for imminent task/meeting | encrypted local cache | hours |
| L2 recent local | recent agent/team knowledge and retrieval index | local Ditto + index | days/weeks |
| L3 durable | source and derived memory records | Ditto-backed durable collection | policy-defined |
| Archive | raw transcript/log/artifact where permitted | encrypted object store | policy-defined |

Promotion changes availability, not authority. A frequently repeated rumor does not become true, and
an urgent meeting does not bypass ACL/data policy.

## Record classes

- `source_event`: immutable normalized reference to ticket/comment/meeting/task evidence.
- `episode`: bounded account of an activity, linked to source events and workflow.
- `fact`: extracted claim with scope, confidence, valid time, and evidence links.
- `procedure`: reviewed playbook with applicability and version.
- `decision`: architecture/team decision with owner, status, supersession, and source.
- `feedback`: who gave it, target, scope, valence, and whether accepted.
- `person_preference`: minimal work preference with visibility/consent; no sensitive profiling.
- `identity`: versioned agent identity reference; authoritative identity remains in identity service.
- `tombstone`: correction/deletion/supersession propagated to caches and indexes.

Every record carries `tenant_id`, owner/subject, provenance, data class, ACL, created/observed/valid
time, retention/expiry, source/derived flag, confidence (derived only), and integrity/version metadata.

## Ingestion pipeline

1. **Eligibility:** source/type allow-list, participant consent, legal hold, data class, tenant policy.
2. **Normalize:** stable source reference, time, author, workflow/meeting, content hash.
3. **Quarantine:** strip active markup, detect encoded/hidden instructions, limit size, malware-scan attachments.
4. **Classify:** source vs derived, topics/entities, ACL, retention, sensitivity.
5. **Store source:** immutable or append-only reference; raw content may remain in the source system.
6. **Derive:** a no-tools reflection worker proposes facts/procedures/feedback links.
7. **Validate:** provenance exists, scope is bounded, conflicts are surfaced, high-impact procedure changes require review.
8. **Index/project:** update Ditto collections and optional lexical/vector index.

“Every event” means every eligible event is considered. It does not mean every utterance is copied or
retained indefinitely.

## Retrieval

Retrieval is policy-filter-first:

1. tenant/agent/subject ACL and data-class filter;
2. task purpose and valid-time filter;
3. tombstone/supersession removal;
4. hybrid lexical/semantic candidates;
5. rank by relevance, source authority, recency/validity, confidence, and diversity;
6. return a bounded bundle containing citations and uncertainty.

The consumer receives source snippets/references plus derived claims, never an unattributed prose blob.
Contradictory credible claims are both returned with their dates and status.

## Warm-up memory

Before an authorized meeting or task, a scheduled builder creates a signed bundle containing current
ticket state, immutable PR/commit references, latest verifier results, blockers, approved decisions,
and minimal attendee work context. It has purpose, ACL, creation time, expiry, and source list. Presence
must reject an expired bundle and can refresh individual facts during the meeting.

## Reflection and learning

Reflection proposes, but cannot silently rewrite truth. Rules:

- source records are immutable except policy-driven redaction/deletion;
- derived records cite sources and prompt/model/template version;
- one comment does not become a team-wide procedure without scope/approval;
- accepted reviewer feedback can influence later planning only for its recorded scope;
- low-confidence or contested claims are not injected as instructions;
- consolidation and compaction preserve provenance chains;
- corrections create a superseding record/tombstone and invalidate dependent caches.

## Ditto boundary

Ditto is a good candidate for local-first memory and selective fleet sync. Its causal consistency and
CRDT merge behavior are appropriate for knowledge replication when schemas handle conflicts. It is not
used for global work claims, approval uniqueness, fencing tokens, or security revocation.

Collections SHOULD separate private per-agent records, approved team knowledge, and sync metadata.
Private `people` profiles do not sync by default. Shared procedures/decisions require explicit publish
status. Subscription coverage and conflict behavior must be tested for each collection.

## Retention, correction, and deletion

- TTL is assigned at ingestion by record/source/data class.
- Raw meeting audio is off by default; transcripts require policy/consent.
- Deletion traverses source, derived records, embeddings, summaries, warm sets, replicas, and artifacts.
- Backups follow documented delayed-deletion/legal-hold semantics.
- A subject can inspect/correct eligible personal memory through an audit workflow.

## Quality and security tests

- poison instruction in ticket, source code, transcript, tool output, and synced record;
- false fact repeatedly mentioned but unsupported;
- correction and deletion across all tiers/indexes/replicas;
- stale decision supersession and valid-time query;
- cross-tenant/agent ACL isolation;
- partial Ditto subscription and concurrent update behavior;
- retrieval precision/recall, citation correctness, and warm-up latency;
- model/reflection upgrade regression.

## Open decisions

- Exact Ditto SDK/version/deployment and encryption/authentication features.
- Memory retention matrix and meeting consent policy.
- Initial lexical/vector index and quality benchmarks.
- Process for approving team-wide procedures and personal preferences.
