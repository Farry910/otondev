# Ditto behaviour spike — measured evidence

- runs: `cap-01`, `probe-02`, `sync-01`
- events: **35**, checks: **14**
- environment: @dittolive/ditto 5.0.3 on win32-x64, node v22.22.2

## Exit-criterion checks

| status | criterion | observed |
|---|---|---|
| _skipped_ | sync convergence between two peers, including a concurrent update to the same record | sync.start() did not activate sync — alice: Error/?: Sync could not be started because Ditto has not yet been activated. This can be achieved with a successful call to `setOfflineOnlyLicenseToken`. If you need to obtain a license token then please visit https://portal.ditto.live.; bob: Error/?: Sync could not be started because Ditto has not yet been activated. This can be achieved with a successful call to `setOfflineOnlyLicenseToken`. If you need to obtain a license token then please visit https://portal.ditto.live. |
| PASS | record and provenance behaviour observed against a real Ditto SDK | nested provenance object, ACL array and explicit null all survived the round trip |
| **FAIL** | source-record immutability is enforceable by the store | UPDATE silently rewrote a source record; Ditto enforces no immutability, so S13 must enforce it above the store |
| PASS | tombstone behaviour observed against a real Ditto SDK | DELETE removed the record locally (rows remaining: 0) |
| PASS | supersession is expressible and queryable | found src-1-correction superseding src-1 |
| PASS | tenant/ACL filtering is expressible in the query language | 2 rows returned, none from another tenant |
| PASS | Ditto is unsuitable for work claims and approval uniqueness | conditional UPDATE is accepted but is local-only and cannot arbitrate between peers; a duplicate INSERT on an existing _id is rejected (Error/store/backend: Document CRDT error: DQL evaluation failed with DQL evaluation error: Identifier conflict on document "claim-1": using FAIL conflict policy) |
| PASS | the query surface can express the MemoryStore operations S13 needs | 8/8 expressible; rejected: none |
| _skipped_ | sync convergence between two peers, including a concurrent update to the same record | DITTO_OFFLINE_LICENSE_TOKEN is not set; sync.start() refuses to run unactivated (observed in sync-capability: "Sync could not be started because Ditto has not yet been activated") |
| _skipped_ | partial subscription: a peer subscribed to a scope does not receive out-of-scope records | DITTO_OFFLINE_LICENSE_TOKEN is not set; sync.start() refuses to run unactivated (observed in sync-capability: "Sync could not be started because Ditto has not yet been activated") |
| _skipped_ | deletion and correction propagate to a synced peer, and the peer's index reflects it | DITTO_OFFLINE_LICENSE_TOKEN is not set; sync.start() refuses to run unactivated (observed in sync-capability: "Sync could not be started because Ditto has not yet been activated") |
| _skipped_ | collection separation for private vs team-approved data holds under sync | DITTO_OFFLINE_LICENSE_TOKEN is not set; sync.start() refuses to run unactivated (observed in sync-capability: "Sync could not be started because Ditto has not yet been activated") |
| _skipped_ | peer authentication behaviour and its failure mode are documented | DITTO_OFFLINE_LICENSE_TOKEN is not set; sync.start() refuses to run unactivated (observed in sync-capability: "Sync could not be started because Ditto has not yet been activated") |
| _skipped_ | confirmed in the spike: Ditto is unsuitable for work claims, approval uniqueness, fencing, and revocation | DITTO_OFFLINE_LICENSE_TOKEN is not set; sync.start() refuses to run unactivated (observed in sync-capability: "Sync could not be started because Ditto has not yet been activated") |

**6 passed, 1 failed, 7 skipped.** A skipped check is an unanswered question, not a pass.

## DQL capability sweep

| MemoryStore need | expressible | statement |
|---|---|---|
| upsert (store source record idempotently) | yes | `INSERT INTO memory DOCUMENTS (:doc) ON ID CONFLICT DO UPDATE` |
| insert-if-absent (ingestion dedupe by content id) | yes | `INSERT INTO memory DOCUMENTS (:doc) ON ID CONFLICT DO NOTHING` |
| ranked retrieval (ORDER BY + LIMIT) | yes | `SELECT * FROM memory WHERE tenant_id = :t ORDER BY valid_from DESC LIMIT 2` |
| query by nested provenance field | yes | `SELECT * FROM memory WHERE provenance.source_system = :s` |
| ACL membership test on an array | yes | `SELECT * FROM memory WHERE array_contains(acl.agents, :a)` |
| valid-time range query | yes | `SELECT * FROM memory WHERE valid_from <= :now AND (valid_to IS NULL OR valid_to > :now)` |
| aggregate count for store metrics | yes | `SELECT COUNT(*) AS n FROM memory` |
| eviction distinct from delete (cache/TTL trimming) | yes | `EVICT FROM memory WHERE _id = :id` |

## Notable observations

- `sdk.defect` — NO_COLOR=1 aborts the process at Ditto.open(); normalised to "false"
- `licence` — no offline licence token available
- `sync.start` — alice: Error/?: Sync could not be started because Ditto has not yet been activated. This can be achieved with a successful call to `setOfflineOnlyLicenseToken`. If you need to obtain a license token then please visit https://portal.ditto.live.
- `sync.start` — bob: Error/?: Sync could not be started because Ditto has not yet been activated. This can be achieved with a successful call to `setOfflineOnlyLicenseToken`. If you need to obtain a license token then please visit https://portal.ditto.live.
- `dql.removal` — removal statement support: DELETE=true, EVICT=not tried
- `dql.tombstone_visibility` — no soft-deleted projection available: Error/query/invalid: Invalid query: `DQL parser error: Unexpected token SHOW at line 1 column 38 near "...T * FROM memory WHERE _id = :id SHOW SOFT DELETED"`. For more information on Ditto's query language see: https://ditto.com/link/dql-guide
- `dql.conditional_write` — conditional UPDATE support: first=true, second=true, winner=agent-1
