# SP3 — Ditto behaviour spike: findings

**Verdict: CONTINUE, provisionally — and the `ditto-spike` gate must not be cleared on this
document alone.**

Nothing observed is disqualifying. Every question answerable on this machine was answered in
Ditto's favour, and the one failure found (source-record immutability) is a fact the design
already accounts for. But the half of the spike that matters most to S14 — anything involving
two peers — could not be executed here, because Ditto refuses to start sync without a
commercial licence token this environment does not have. That is a blocker to obtain, not a
result to interpret.

> **Before clearing `ditto-spike`, read "Board checkboxes overstate criterion 7" below.** The
> board card shows criterion 7 as met. This document is the authority, and it does not support
> that tick.

## Exactly what was tested

| | |
|---|---|
| SDK | `@dittolive/ditto` **5.0.3** (npm, `dependencies`) |
| Platform | win32-x64, Node **v22.22.2** |
| Identity mode | `DittoConfig` `{ mode: 'smallPeersOnly' }`, database ID `0f3d5b0e-…-1a0f2c3d4e5b` |
| Transports | every discovery mechanism disabled (BLE, AWDL, Wi-Fi Aware, mDNS, multicast); peers introduced only by explicit `127.0.0.1:<port>` |
| Evidence | `evidence/events-*.jsonl`, rendered by `npm run report` |

Transports are locked down deliberately: a spike must not broadcast a synthetic memory database
onto a real network, and discovery flakiness would otherwise be indistinguishable from a CRDT
failing to converge.

## The blocker

`ditto.sync.start()` throws, verbatim:

> Sync could not be started because Ditto has not yet been activated. This can be achieved with
> a successful call to `setOfflineOnlyLicenseToken`. If you need to obtain a license token then
> please visit https://portal.ditto.live.

Observed, not read in documentation — see `sync-capability` in the evidence log. Two facts follow:

- **Local reads and writes work fully unactivated.** The store opens, DQL executes, records
  persist. Only sync is gated.
- **Offline peer-to-peer sync still requires a licence.** `smallPeersOnly` is not a
  no-credentials mode; `DittoConfig.requiresOfflineLicenseToken` reports `true` for it.

This is an architecture-relevant fact in its own right, independent of the spike: the memory
plane's *replication* capability is gated on a commercial licence with an expiry, while its
local behaviour is not. An expired token in production would therefore not fail loudly at
startup — it would leave each node working perfectly on its own while silently ceasing to
share. Whatever S14 does, it needs an explicit health signal for "activated and syncing", not
just "store is up".

## What is proven

All from single-peer runs; see the evidence log for the raw records.

- **Records and provenance survive intact.** A design-shaped `source_event` — nested
  `provenance` object, nested `acl.agents` array, an explicit `valid_to: null` — round-tripped
  byte-for-byte. Explicit null is preserved rather than collapsed to absent, which matters
  because "no end of validity" and "validity unknown" are different claims.
- **Supersession is expressible.** A correcting record carrying `supersedes: <id>` is queryable
  by the id it supersedes.
- **Removal statements exist and differ.** `DELETE FROM …` is accepted and the record stops
  being returned locally; `EVICT FROM …` is a separate accepted statement. `SELECT … SHOW SOFT
  DELETED` is *not* valid DQL in 5.0.3 (parser error), so this spike has **no local way to
  observe whether `DELETE` leaves a propagating tombstone or merely forgets**. That distinction
  is the entire content of exit criterion 4 and remains unanswered.
- **The query surface covers the `MemoryStore` operations S13 needs** — 8 of 8 probed
  statements accepted (table below).
- **Duplicate identity is rejected, not merged.** A second `INSERT` on an existing `_id` fails
  with `Identifier conflict on document "claim-1": using FAIL conflict policy`, and
  `ON ID CONFLICT DO UPDATE` / `DO NOTHING` are both available. So idempotent ingestion has a
  first-class primitive.

### `MemoryStore` conformance — what a Ditto adapter could satisfy

| S13 need | DQL used | Expressible |
|---|---|---|
| upsert a source record idempotently | `INSERT … ON ID CONFLICT DO UPDATE` | yes |
| insert-if-absent (ingestion dedupe) | `INSERT … ON ID CONFLICT DO NOTHING` | yes |
| ranked retrieval | `SELECT … ORDER BY … LIMIT` | yes |
| query by nested provenance field | `WHERE provenance.source_system = :s` | yes |
| ACL membership test | `WHERE array_contains(acl.agents, :a)` | yes |
| valid-time range query | `WHERE valid_from <= :now AND (valid_to IS NULL OR valid_to > :now)` | yes |
| store metrics | `SELECT COUNT(*) AS n` | yes |
| cache/TTL trimming distinct from delete | `EVICT FROM …` | yes |

Two cautions on that table. It shows these operations are **expressible**, not that they are
**correct under sync** — a filter is not an access-control boundary, and `WHERE tenant_id = :t`
returning only tenant A's rows proves the query language works, not that tenant B's rows never
reached the device. Whether they reach it is criterion 3, which is blocked. Second, the
conformance suite S14 must pass is the one S13 writes; this list is derived from S13's brief and
`memory-service.md`, and should be re-checked against that suite when it exists.

## What failed

**Ditto cannot enforce source-record immutability.** A plain `UPDATE` rewrote a record marked
`record_class: 'source_event'`, `is_derived: false`, with no error. There is no immutable-field
or append-only concept in the store.

This does not contradict the design — `memory-service.md` already places immutability in the
Memory Service ("source records are immutable except policy-driven redaction/deletion"). It does
sharpen a requirement for S13 and S14: **immutability must be enforced above the store and
cannot be delegated to it.** Because Ditto is local-first and multi-writer, any peer holding a
write path to the collection can rewrite a source record and the change will replicate as an
ordinary merge. The practical consequence is that "source" collections need to be unreachable
by the derived-write path at the capability level, not merely by convention.

## What is unproven, and why

Exit criteria 2, 3, 4, 5 and 6 all require two peers exchanging data. Every one is recorded as
**skipped** in the evidence, with the activation error as the observed reason. Specifically
unanswered:

- convergence, and which side wins a concurrent update to the same record;
- whether a partial subscription really withholds out-of-scope records, or merely filters them
  after they have already reached the device;
- whether `DELETE` propagates a tombstone that removes the record on a peer, or is local-only;
- whether private and team-approved collections stay separated under sync;
- peer authentication behaviour, and what a peer with a mismatched shared secret actually
  experiences.

Exit criterion 7 (unsuitability for claims, approvals, fencing, revocation) is **partially**
confirmed and deliberately left unticked. What is established locally: the API exposes no
consensus, lease, or uniqueness primitive across peers; conditional `UPDATE … WHERE … IS NULL`
is accepted but is evaluated against one replica; conflict resolution is CRDT merge. What is not
yet demonstrated is the decisive experiment — two partitioned peers *both* successfully claiming
the same item and the merge silently discarding one. The design's negative assumption looks
correct, but the card says "confirmed in the spike, not assumed", so it stays open.

## Board checkboxes overstate criterion 7

The card `board/packages/SP3-ditto-behaviour-spike.md` records criterion 7 — *"confirmed in the
spike, not assumed: Ditto is unsuitable for work claims, approval uniqueness, fencing, and
revocation"* — as **met**. It is not met, and it was never claimed to be: the section above says
it is "**partially** confirmed and deliberately left unticked". The tick was applied to the card
without corresponding evidence. Treat the checkbox as wrong and this section as correct.

The board offers no way to un-tick a criterion (`check` only ever sets), so the correction lives
here rather than on the card.

What criterion 7 actually rests on today is **local, single-peer, negative-space evidence**:

- the API surface exposes no consensus, lease, or cross-peer uniqueness primitive;
- conditional `UPDATE … WHERE … IS NULL` is accepted, but is evaluated against one replica;
- conflict resolution is CRDT merge, which by construction has no "loser" to report.

That is a sound basis for *believing* the design's negative assumption. It is not the
confirmation the criterion asks for. The decisive experiment — two partitioned peers each
succeeding at the same exclusive claim, then merging with one write silently discarded — needs
sync, and so is blocked on the same licence token as criteria 2–6. `npm run sync-suite` contains
that case and will answer it.

Why this matters more than the other five blocked boxes: criteria 2–6 are unticked, so they
advertise their own incompleteness. This one advertises the opposite. Anyone clearing the
`ditto-spike` gate from the card alone would conclude that Ditto had been *demonstrated* unsafe
for claims and fencing, when what was demonstrated is only that it offers nothing to make them
safe. The design's capability split is very likely right — but "very likely right" is what the
criterion was written to rule out.

## Finishing this spike

The suite for the blocked criteria is written and typechecks; it is not speculative scaffolding.
With a token it runs unattended:

```powershell
$env:DITTO_OFFLINE_LICENSE_TOKEN = '<offline-only token from portal.ditto.live>'
npm install
npm run sync-suite      # criteria 2-6, plus the decisive negative case for 7
npm run report
```

`src/sync.ts` partitions the peers by stopping sync rather than by sleeping, so the concurrent
writes are genuinely concurrent, and it asserts the absence of out-of-scope records only after
an in-scope record written later has already arrived — otherwise "did not arrive" would pass for
the wrong reason.

## SDK integration hazard found

`@dittolive/ditto` 5.0.3 **aborts the Node process** during `Ditto.open()` when `NO_COLOR` is
set to anything other than `true` or `false`. The conventional `NO_COLOR=1` triggers it. The
failure is a Rust panic across a `nounwind` FFI boundary, so it is not catchable in JavaScript:
the process dies with a Rust backtrace and no exception. `NO_COLOR=1` is common in CI, so this
would present as an unreproducible CI-only crash. `src/runtime.ts` normalises the variable
before the addon loads — which requires a dynamic import, since ESM would otherwise hoist the
SDK import above any `process.env` assignment.

## Recommendation

Obtain an offline-only licence token and re-run `npm run sync-suite` before clearing
`ditto-spike`. If the sync results hold up, S14 is viable and the boundary in
`memory-service.md` ("not used for global work claims, approval uniqueness, fencing tokens, or
security revocation") should be treated as a hard capability split rather than a guideline —
nothing in the API would stop an implementer from trying, and nothing in the store would report
that it had gone wrong.

S13 is unaffected either way: it builds on `MemoryStore` with a SQLite reference implementation,
which is exactly why this spike is not on its critical path.
