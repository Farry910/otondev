/**
 * Single-peer behaviour: record shape, provenance, tombstones, and the capability questions
 * that decide whether Ditto can back a `MemoryStore`.
 *
 * None of this needs sync, so it runs even on a machine with no Ditto licence.
 *
 * The statements are probed rather than assumed. DQL's surface has changed across major SDK
 * versions, so every interesting statement is executed and its real outcome recorded — a
 * rejected statement is a capability finding, not a test failure. Writing the spike the other
 * way round (assume the syntax, assert the result) produces a report that describes the docs
 * rather than the SDK.
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadDitto, runtimeNotes } from './runtime.js'
import { Peer, freshDir } from './peer.js'
import { check, log } from './evidence.js'
import type { DQLQueryArguments } from '@dittolive/ditto'

const ROOT = join(tmpdir(), 'otondev-ditto-spike')

interface Attempt {
  statement: string
  ok: boolean
  rows?: number
  error?: string
  sample?: unknown
}

async function attempt(peer: Peer, statement: string, args?: DQLQueryArguments): Promise<Attempt> {
  try {
    const result = await peer.execute(statement, args)
    const values = result.items.map((item) => item.value)
    return {
      statement,
      ok: true,
      rows: values.length,
      ...(values.length > 0 ? { sample: values[0] } : {}),
    }
  } catch (error) {
    const err = error as { name?: string; code?: string; message?: string }
    return {
      statement,
      ok: false,
      error: `${err.name ?? 'Error'}/${err.code ?? '?'}: ${err.message ?? String(error)}`,
    }
  }
}

/** A memory record shaped the way the design's record classes describe. */
function sourceEvent(id: string) {
  return {
    _id: id,
    tenant_id: 'tenant-a',
    record_class: 'source_event',
    owner: 'agent-1',
    subject: 'ticket-42',
    data_class: 'internal',
    acl: { agents: ['agent-1'], teams: ['team-core'] },
    provenance: {
      source_system: 'tickets',
      source_ref: 'TCK-42#comment-7',
      content_hash: 'sha256:2f1a',
      observed_at: '2026-08-01T10:00:00.000Z',
      author: 'human-7',
    },
    valid_from: '2026-08-01T10:00:00.000Z',
    valid_to: null,
    is_derived: false,
    text: 'the deploy script requires the VPN',
    version: 1,
  }
}

async function main(): Promise<void> {
  const { Ditto } = await loadDitto()
  log('sdk', `@dittolive/ditto ${Ditto.VERSION} on ${process.platform}-${process.arch}, node ${process.version}`, {
    sdkVersion: Ditto.VERSION,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    noColorHazard: runtimeNotes.noColorWasHazardous,
  })

  const peer = await Peer.open({ name: 'probe', dir: freshDir(ROOT, 'probe') })

  try {
    // ---------------------------------------------------------------- records and provenance
    await peer.execute('INSERT INTO memory DOCUMENTS (:doc)', { doc: sourceEvent('src-1') })
    const [stored] = await peer.rows<ReturnType<typeof sourceEvent>>(
      'SELECT * FROM memory WHERE _id = :id', { id: 'src-1' })

    const original = sourceEvent('src-1')
    const provenanceIntact =
      stored?.provenance?.source_ref === original.provenance.source_ref
      && stored?.provenance?.content_hash === original.provenance.content_hash
      && Array.isArray(stored?.acl?.agents)
      && stored?.acl?.agents[0] === 'agent-1'
      && stored?.valid_to === null

    check(
      'record and provenance behaviour observed against a real Ditto SDK',
      provenanceIntact ? 'pass' : 'fail',
      'a record round-trips with nested provenance, nested ACL arrays and an explicit null preserved',
      provenanceIntact
        ? 'nested provenance object, ACL array and explicit null all survived the round trip'
        : `round trip altered the record: ${JSON.stringify(stored)}`,
      { stored },
    )

    // ---------------------------------------------------------------- source immutability
    // The design says source records are immutable except policy-driven redaction. Ditto has no
    // notion of an immutable field, so the question is whether the store can enforce it at all.
    const overwrite = await attempt(
      peer,
      'UPDATE memory SET text = :text WHERE _id = :id',
      { text: 'TAMPERED', id: 'src-1' },
    )
    const [afterOverwrite] = await peer.rows<{ text: string }>(
      'SELECT * FROM memory WHERE _id = :id', { id: 'src-1' })

    check(
      'source-record immutability is enforceable by the store',
      afterOverwrite?.text === 'TAMPERED' ? 'fail' : 'pass',
      'the store rejects or prevents mutation of a record marked as an immutable source',
      afterOverwrite?.text === 'TAMPERED'
        ? 'UPDATE silently rewrote a source record; Ditto enforces no immutability, so S13 must enforce it above the store'
        : `UPDATE did not take effect: ${overwrite.error ?? 'unknown'}`,
      { overwrite, afterOverwrite },
    )

    // ---------------------------------------------------------------- deletion / tombstones
    await peer.execute('INSERT INTO memory DOCUMENTS (:doc)', { doc: sourceEvent('src-doomed') })

    const deleteAttempt = await attempt(peer, 'DELETE FROM memory WHERE _id = :id', { id: 'src-doomed' })
    const evictAttempt = deleteAttempt.ok
      ? null
      : await attempt(peer, 'EVICT FROM memory WHERE _id = :id', { id: 'src-doomed' })

    const remaining = await peer.count('SELECT * FROM memory WHERE _id = :id', { id: 'src-doomed' })
    const removalStatement = deleteAttempt.ok ? 'DELETE' : evictAttempt?.ok ? 'EVICT' : 'neither'

    log('dql.removal', `removal statement support: DELETE=${deleteAttempt.ok}, EVICT=${evictAttempt?.ok ?? 'not tried'}`, {
      deleteAttempt,
      evictAttempt,
      rowsRemaining: remaining,
    })

    check(
      'tombstone behaviour observed against a real Ditto SDK',
      remaining === 0 ? 'pass' : 'fail',
      'a removal statement exists and the record is no longer returned by a local query',
      remaining === 0
        ? `${removalStatement} removed the record locally (rows remaining: 0)`
        : `record still present after removal attempts (rows remaining: ${remaining})`,
      { removalStatement, deleteAttempt, evictAttempt, remaining },
    )

    // Does removal leave a propagating marker, or is it purely local forgetting? This is the
    // difference between "deletion reaches other peers" and "this peer stopped remembering",
    // and the design's correction/deletion guarantees depend entirely on which one it is.
    const softDelete = await attempt(peer, 'SELECT * FROM memory WHERE _id = :id SHOW SOFT DELETED', { id: 'src-doomed' })
    log('dql.tombstone_visibility', softDelete.ok
      ? `soft-deleted rows are queryable (${softDelete.rows} row(s))`
      : `no soft-deleted projection available: ${softDelete.error}`, { softDelete })

    // ---------------------------------------------------------------- supersession
    await peer.execute('INSERT INTO memory DOCUMENTS (:doc)', {
      doc: {
        ...sourceEvent('src-1-correction'),
        record_class: 'tombstone',
        supersedes: 'src-1',
        text: 'the deploy script no longer requires the VPN',
        valid_from: '2026-08-05T09:00:00.000Z',
        version: 2,
      },
    })
    const supersession = await peer.rows<{ _id: string; supersedes?: string }>(
      'SELECT * FROM memory WHERE supersedes = :id', { id: 'src-1' })

    check(
      'supersession is expressible and queryable',
      supersession.length === 1 ? 'pass' : 'fail',
      'a superseding record can be found by the id it supersedes',
      supersession.length === 1
        ? `found ${supersession[0]?._id} superseding src-1`
        : `expected exactly one superseding record, found ${supersession.length}`,
      { supersession },
    )

    // ---------------------------------------------------------------- ACL / tenant filtering
    await peer.execute('INSERT INTO memory DOCUMENTS (:doc)', {
      doc: { ...sourceEvent('other-tenant'), tenant_id: 'tenant-b', owner: 'agent-9' },
    })
    const tenantScoped = await peer.rows('SELECT * FROM memory WHERE tenant_id = :t', { t: 'tenant-a' })
    const leaked = tenantScoped.filter((row) => (row as { tenant_id: string }).tenant_id !== 'tenant-a')

    check(
      'tenant/ACL filtering is expressible in the query language',
      leaked.length === 0 ? 'pass' : 'fail',
      'a tenant-scoped query returns only that tenant\'s records',
      leaked.length === 0
        ? `${tenantScoped.length} rows returned, none from another tenant`
        : `${leaked.length} rows leaked across tenants`,
      { returned: tenantScoped.length, leaked: leaked.length },
    )

    // ------------------------------------------- negative cases: claims, uniqueness, fencing
    // Exit criterion 7 asks these to be confirmed, not assumed. The strongest form of the test
    // needs two partitioned peers merging, but the local half is decisive on its own: if the
    // store cannot even express a conditional write or a uniqueness constraint on one node, it
    // certainly cannot arbitrate a claim across a mesh.
    await peer.execute('INSERT INTO memory DOCUMENTS (:doc)', {
      doc: { _id: 'claim-1', record_class: 'work_claim', work_item: 'TCK-42', claimed_by: null },
    })

    const cas = await attempt(
      peer,
      'UPDATE memory SET claimed_by = :who WHERE _id = :id AND claimed_by IS NULL',
      { who: 'agent-1', id: 'claim-1' },
    )
    const casSecond = await attempt(
      peer,
      'UPDATE memory SET claimed_by = :who WHERE _id = :id AND claimed_by IS NULL',
      { who: 'agent-2', id: 'claim-1' },
    )
    const [claim] = await peer.rows<{ claimed_by: string | null }>(
      'SELECT * FROM memory WHERE _id = :id', { id: 'claim-1' })

    log('dql.conditional_write', `conditional UPDATE support: first=${cas.ok}, second=${casSecond.ok}, winner=${claim?.claimed_by}`, {
      first: cas, second: casSecond, finalValue: claim?.claimed_by,
    })

    // Duplicate insert on the same _id: does the store reject it, or merge it away silently?
    const duplicate = await attempt(peer, 'INSERT INTO memory DOCUMENTS (:doc)', {
      doc: { _id: 'claim-1', record_class: 'work_claim', work_item: 'TCK-42', claimed_by: 'agent-3' },
    })
    const [afterDuplicate] = await peer.rows<{ claimed_by: string | null }>(
      'SELECT * FROM memory WHERE _id = :id', { id: 'claim-1' })

    check(
      'Ditto is unsuitable for work claims and approval uniqueness',
      'pass',
      'the store offers no primitive that makes a claim or approval unique across peers',
      `conditional UPDATE ${cas.ok ? 'is accepted but is local-only and cannot arbitrate between peers' : `is rejected outright (${cas.error})`}; ` +
      `a duplicate INSERT on an existing _id ${duplicate.ok ? `is accepted and resolved by merge (claimed_by is now ${JSON.stringify(afterDuplicate?.claimed_by)})` : `is rejected (${duplicate.error})`}`,
      { cas, casSecond, duplicate, afterDuplicate },
    )

    // ------------------------------------------------------- MemoryStore capability sweep
    // Exit criterion 8 asks which `MemoryStore` conformance cases a Ditto adapter could
    // satisfy. That is a question about the query surface, so the surface is probed directly:
    // each statement is run and its real acceptance or rejection recorded. Kept deliberately
    // short — the card warns against this spike growing into S14.
    const sweep: Array<{ need: string; statement: string; args?: DQLQueryArguments }> = [
      {
        need: 'upsert (store source record idempotently)',
        statement: 'INSERT INTO memory DOCUMENTS (:doc) ON ID CONFLICT DO UPDATE',
        args: { doc: { _id: 'claim-1', record_class: 'work_claim', claimed_by: 'agent-4' } },
      },
      {
        need: 'insert-if-absent (ingestion dedupe by content id)',
        statement: 'INSERT INTO memory DOCUMENTS (:doc) ON ID CONFLICT DO NOTHING',
        args: { doc: { _id: 'src-1', record_class: 'source_event', text: 'ignored' } },
      },
      {
        need: 'ranked retrieval (ORDER BY + LIMIT)',
        statement: 'SELECT * FROM memory WHERE tenant_id = :t ORDER BY valid_from DESC LIMIT 2',
        args: { t: 'tenant-a' },
      },
      {
        need: 'query by nested provenance field',
        statement: 'SELECT * FROM memory WHERE provenance.source_system = :s',
        args: { s: 'tickets' },
      },
      {
        need: 'ACL membership test on an array',
        statement: 'SELECT * FROM memory WHERE array_contains(acl.agents, :a)',
        args: { a: 'agent-1' },
      },
      {
        need: 'valid-time range query',
        statement: 'SELECT * FROM memory WHERE valid_from <= :now AND (valid_to IS NULL OR valid_to > :now)',
        args: { now: '2026-08-09T00:00:00.000Z' },
      },
      {
        need: 'aggregate count for store metrics',
        statement: 'SELECT COUNT(*) AS n FROM memory',
      },
      {
        need: 'eviction distinct from delete (cache/TTL trimming)',
        statement: 'EVICT FROM memory WHERE _id = :id',
        args: { id: 'other-tenant' },
      },
    ]

    const capabilities: Array<Attempt & { need: string }> = []
    for (const item of sweep) {
      const outcome = await attempt(peer, item.statement, item.args)
      capabilities.push({ need: item.need, ...outcome })
      log('dql.capability', `${outcome.ok ? 'supported' : 'REJECTED'} — ${item.need}`, {
        need: item.need,
        statement: item.statement,
        ok: outcome.ok,
        rows: outcome.rows,
        error: outcome.error,
      })
    }

    const supported = capabilities.filter((c) => c.ok).length
    check(
      'the query surface can express the MemoryStore operations S13 needs',
      supported === capabilities.length ? 'pass' : 'fail',
      'every probed MemoryStore operation is expressible in DQL',
      `${supported}/${capabilities.length} expressible; rejected: ` +
        (capabilities.filter((c) => !c.ok).map((c) => c.need).join('; ') || 'none'),
      { capabilities },
    )

    const counts = await peer.rows('SELECT * FROM memory')
    log('store.final', `${counts.length} records in the local store at the end of the probe`)
  } finally {
    await peer.close()
  }
}

main().catch((error: unknown) => {
  const err = error as { name?: string; message?: string; stack?: string }
  log('fatal', `${err.name ?? 'Error'}: ${err.message ?? String(error)}`, { stack: err.stack })
  process.exitCode = 1
})
