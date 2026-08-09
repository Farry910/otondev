/**
 * Two-peer behaviour: exit criteria 2 through 6.
 *
 * Requires an offline licence token in `DITTO_OFFLINE_LICENSE_TOKEN`. Without one,
 * `sync.start()` throws and every check here records `skipped` with the observed error — the
 * one thing this file must never do is report a pass for a test that could not run.
 *
 * Structure of each test is the same and deliberate: write on one peer, then *wait* on the
 * other for a bounded time and record how long it took. A fixed sleep would either make the
 * suite slow or make it flaky, and neither produces a latency number anyone can quote.
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadDitto } from './runtime.js'
import { Peer, freshDir, logPeer } from './peer.js'
import { check, log, waitUntil } from './evidence.js'

const LICENCE = process.env['DITTO_OFFLINE_LICENSE_TOKEN']
const ROOT = join(tmpdir(), 'otondev-ditto-spike-sync')
const PORT = 44_311
const SYNC_TIMEOUT = 20_000

/** Collections the design asks to be kept apart. */
const PRIVATE = 'memory_private'
const APPROVED = 'memory_approved'

const CRITERIA = {
  convergence: 'sync convergence between two peers, including a concurrent update to the same record',
  partial: 'partial subscription: a peer subscribed to a scope does not receive out-of-scope records',
  deletion: 'deletion and correction propagate to a synced peer, and the peer\'s index reflects it',
  collections: 'collection separation for private vs team-approved data holds under sync',
  peerAuth: 'peer authentication behaviour and its failure mode are documented',
  negatives: 'confirmed in the spike: Ditto is unsuitable for work claims, approval uniqueness, fencing, and revocation',
} as const

function skipAll(reason: string): void {
  for (const criterion of Object.values(CRITERIA)) {
    check(criterion, 'skipped', 'two peers exchange data over a running sync session', reason)
  }
}

async function main(): Promise<number> {
  const { Ditto } = await loadDitto()
  log('sdk', `@dittolive/ditto ${Ditto.VERSION} on ${process.platform}-${process.arch}, node ${process.version}`)

  if (!LICENCE) {
    skipAll('DITTO_OFFLINE_LICENSE_TOKEN is not set; sync.start() refuses to run unactivated '
      + '(observed in sync-capability: "Sync could not be started because Ditto has not yet been activated")')
    return 2
  }

  const alice = await Peer.open({ name: 'alice', dir: freshDir(ROOT, 'alice'), listenPort: PORT })
  const bob = await Peer.open({ name: 'bob', dir: freshDir(ROOT, 'bob'), connectTo: [`127.0.0.1:${PORT}`] })

  try {
    for (const peer of [alice, bob]) {
      const activation = peer.activate(LICENCE)
      log('activate', `${peer.name}: ${activation.detail}`, { peer: peer.name, ...activation })
      if (!activation.activated) {
        skipAll(`activation failed for ${peer.name}: ${activation.detail}`)
        return 3
      }
    }

    for (const peer of [alice, bob]) {
      const started = peer.startSync()
      log('sync.start', `${peer.name}: ${started.detail}`, { peer: peer.name, ...started })
      if (!started.started) {
        skipAll(`sync.start() failed for ${peer.name}: ${started.detail}`)
        return 3
      }
    }

    const connected = await waitUntil(
      async () => alice.remotePeerCount > 0 && bob.remotePeerCount > 0, SYNC_TIMEOUT)
    logPeer(alice, connected.ok ? `saw a peer in ${connected.ms} ms` : 'never saw a peer')
    logPeer(bob, connected.ok ? `saw a peer in ${connected.ms} ms` : 'never saw a peer')

    // Subscriptions are what actually move data; a query alone reads only the local replica.
    // Bob deliberately subscribes to a *scope*, not to everything, so criterion 3 is a
    // property of the run rather than a separate special case.
    alice.subscribe(`SELECT * FROM ${PRIVATE}`)
    alice.subscribe(`SELECT * FROM ${APPROVED}`)
    bob.subscribe(`SELECT * FROM ${APPROVED} WHERE tenant_id = :t`, { t: 'tenant-a' })

    // ------------------------------------------------------------------ criterion 2
    await alice.execute(`INSERT INTO ${APPROVED} DOCUMENTS (:doc)`, {
      doc: { _id: 'fact-1', tenant_id: 'tenant-a', text: 'written on alice', version: 1 },
    })
    const converged = await bob.waitForRows(
      `SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'fact-1' },
      (rows) => rows.length === 1, SYNC_TIMEOUT)

    // Concurrent update to the same record: partition, write both sides, reconnect, compare.
    // Partitioning by stopping sync is what makes the writes genuinely concurrent rather than
    // merely fast — without it one write almost always lands before the other is issued.
    bob.stopSync()
    await waitUntil(async () => alice.remotePeerCount === 0, 5_000)
    await alice.execute(`UPDATE ${APPROVED} SET text = :t, version = 2 WHERE _id = :id`,
      { t: 'edited on alice while partitioned', id: 'fact-1' })
    await bob.execute(`UPDATE ${APPROVED} SET text = :t, version = 3 WHERE _id = :id`,
      { t: 'edited on bob while partitioned', id: 'fact-1' })
    bob.startSync()

    const rejoined = await waitUntil(
      async () => alice.remotePeerCount > 0 && bob.remotePeerCount > 0, SYNC_TIMEOUT)
    const settled = await waitUntil(async () => {
      const [a] = await alice.rows<{ text: string }>(`SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'fact-1' })
      const [b] = await bob.rows<{ text: string }>(`SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'fact-1' })
      return a !== undefined && b !== undefined && a.text === b.text
    }, SYNC_TIMEOUT)

    const [aliceFinal] = await alice.rows<{ text: string; version: number }>(
      `SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'fact-1' })
    const [bobFinal] = await bob.rows<{ text: string; version: number }>(
      `SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'fact-1' })

    check(
      CRITERIA.convergence,
      converged.ok && settled.ok ? 'pass' : 'fail',
      'a record propagates A→B, and a concurrent update on both sides converges to one identical value',
      converged.ok
        ? (settled.ok
            ? `propagated in ${converged.ms} ms; after a partitioned concurrent update both peers agree on `
              + `${JSON.stringify(aliceFinal?.text)} (version ${aliceFinal?.version}) — the losing write is silently discarded`
            : `propagated in ${converged.ms} ms but the peers never agreed: alice=${JSON.stringify(aliceFinal)} bob=${JSON.stringify(bobFinal)}`)
        : `record never reached bob within ${converged.ms} ms`,
      { converged, rejoined, settled, aliceFinal, bobFinal },
    )

    // ------------------------------------------------------------------ criterion 3
    await alice.execute(`INSERT INTO ${APPROVED} DOCUMENTS (:doc)`, {
      doc: { _id: 'fact-other-tenant', tenant_id: 'tenant-b', text: 'must not reach bob' },
    })
    // Give an out-of-scope record the same opportunity to arrive as an in-scope one, then
    // assert absence. Asserting a negative immediately would pass for the wrong reason.
    await alice.execute(`INSERT INTO ${APPROVED} DOCUMENTS (:doc)`, {
      doc: { _id: 'fact-2', tenant_id: 'tenant-a', text: 'in scope, arrives second' },
    })
    const inScopeArrived = await bob.waitForRows(
      `SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'fact-2' },
      (rows) => rows.length === 1, SYNC_TIMEOUT)
    const outOfScope = await bob.count(
      `SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'fact-other-tenant' })

    check(
      CRITERIA.partial,
      inScopeArrived.ok && outOfScope === 0 ? 'pass' : 'fail',
      'an in-scope record arrives and an out-of-scope record, given the same time, does not',
      `in-scope record arrived=${inScopeArrived.ok} (${inScopeArrived.ms} ms); out-of-scope rows on bob=${outOfScope}`,
      { inScopeArrived, outOfScope },
    )

    // ------------------------------------------------------------------ criterion 5
    await alice.execute(`INSERT INTO ${PRIVATE} DOCUMENTS (:doc)`, {
      doc: { _id: 'private-1', tenant_id: 'tenant-a', text: 'private to alice' },
    })
    const privateLeak = await waitUntil(
      async () => (await bob.count(`SELECT * FROM ${PRIVATE} WHERE _id = :id`, { id: 'private-1' })) > 0,
      5_000)

    check(
      CRITERIA.collections,
      privateLeak.ok ? 'fail' : 'pass',
      'a record in the private collection never reaches a peer that only subscribes to the approved collection',
      privateLeak.ok
        ? `private record reached bob after ${privateLeak.ms} ms — collection separation does NOT hold`
        : `private record still absent on bob after ${privateLeak.ms} ms of opportunity`,
      { privateLeak },
    )

    // ------------------------------------------------------------------ criterion 4
    await alice.execute(`UPDATE ${APPROVED} SET text = :t WHERE _id = :id`,
      { t: 'corrected on alice', id: 'fact-2' })
    const correctionArrived = await bob.waitForRows<{ text: string }>(
      `SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'fact-2' },
      (rows) => rows[0]?.text === 'corrected on alice', SYNC_TIMEOUT)

    await alice.execute(`DELETE FROM ${APPROVED} WHERE _id = :id`, { id: 'fact-2' })
    const deletionArrived = await bob.waitForRows(
      `SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'fact-2' },
      (rows) => rows.length === 0, SYNC_TIMEOUT)

    check(
      CRITERIA.deletion,
      correctionArrived.ok && deletionArrived.ok ? 'pass' : 'fail',
      'a correction and a subsequent deletion both reach the synced peer and are reflected in its queries',
      `correction propagated=${correctionArrived.ok} (${correctionArrived.ms} ms); `
        + `deletion propagated=${deletionArrived.ok} (${deletionArrived.ms} ms)`,
      { correctionArrived, deletionArrived },
    )

    // ------------------------------------------------------------------ criterion 6
    // A third peer with a different shared secret must not be able to join the mesh.
    const mallory = await Peer.open({
      name: 'mallory',
      dir: freshDir(ROOT, 'mallory'),
      connectTo: [`127.0.0.1:${PORT}`],
      privateKey: 'a-different-shared-secret',
    })
    let malloryDetail: string
    try {
      mallory.activate(LICENCE)
      const started = mallory.startSync()
      malloryDetail = started.detail
      mallory.subscribe(`SELECT * FROM ${APPROVED}`)
      const joined = await waitUntil(async () => mallory.remotePeerCount > 0, 10_000)
      const stole = await mallory.count(`SELECT * FROM ${APPROVED}`)

      check(
        CRITERIA.peerAuth,
        joined.ok || stole > 0 ? 'fail' : 'pass',
        'a peer presenting a different shared secret cannot join the mesh or read its records',
        joined.ok
          ? `mallory joined the mesh after ${joined.ms} ms and could read ${stole} record(s)`
          : `mallory never joined (${joined.ms} ms) and read ${stole} record(s); start detail: ${malloryDetail}`,
        { joined, stole, malloryDetail },
      )
    } finally {
      await mallory.close()
    }

    // ------------------------------------------------------------------ criterion 7
    // The decisive form of the negative case: partition, let both peers claim the same work
    // item, then reconnect. If both believe they hold the claim and the merge simply picks one,
    // Ditto cannot be the authority for claims, approvals, fencing, or revocation.
    await alice.execute(`INSERT INTO ${APPROVED} DOCUMENTS (:doc)`, {
      doc: { _id: 'claim-x', tenant_id: 'tenant-a', record_class: 'work_claim', claimed_by: null },
    })
    await bob.waitForRows(`SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'claim-x' },
      (rows) => rows.length === 1, SYNC_TIMEOUT)

    bob.stopSync()
    await waitUntil(async () => alice.remotePeerCount === 0, 5_000)
    await alice.execute(`UPDATE ${APPROVED} SET claimed_by = :w WHERE _id = :id AND claimed_by IS NULL`,
      { w: 'agent-alice', id: 'claim-x' })
    await bob.execute(`UPDATE ${APPROVED} SET claimed_by = :w WHERE _id = :id AND claimed_by IS NULL`,
      { w: 'agent-bob', id: 'claim-x' })

    const [aliceClaim] = await alice.rows<{ claimed_by: string }>(
      `SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'claim-x' })
    const [bobClaim] = await bob.rows<{ claimed_by: string }>(
      `SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'claim-x' })
    const bothWon = aliceClaim?.claimed_by === 'agent-alice' && bobClaim?.claimed_by === 'agent-bob'

    bob.startSync()
    await waitUntil(async () => alice.remotePeerCount > 0 && bob.remotePeerCount > 0, SYNC_TIMEOUT)
    const merged = await waitUntil(async () => {
      const [a] = await alice.rows<{ claimed_by: string }>(`SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'claim-x' })
      const [b] = await bob.rows<{ claimed_by: string }>(`SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'claim-x' })
      return a?.claimed_by === b?.claimed_by
    }, SYNC_TIMEOUT)
    const [afterMerge] = await alice.rows<{ claimed_by: string }>(
      `SELECT * FROM ${APPROVED} WHERE _id = :id`, { id: 'claim-x' })

    check(
      CRITERIA.negatives,
      bothWon ? 'pass' : 'fail',
      'while partitioned, two peers both succeed in claiming the same item, and the merge silently discards one',
      bothWon
        ? `both peers held the claim while partitioned (alice=${aliceClaim?.claimed_by}, bob=${bobClaim?.claimed_by}); `
          + `after rejoin they converged on ${JSON.stringify(afterMerge?.claimed_by)} with no error raised to either side `
          + `— an agent acted on a claim it did not ultimately hold`
        : `the partitioned claims did not both succeed (alice=${aliceClaim?.claimed_by}, bob=${bobClaim?.claimed_by}); `
          + 'the negative case is not demonstrated by this run',
      { aliceClaim, bobClaim, merged, afterMerge },
    )

    return 0
  } finally {
    await bob.close()
    await alice.close()
  }
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error: unknown) => {
    const err = error as { name?: string; code?: string; message?: string }
    log('fatal', `${err.name ?? 'Error'}/${err.code ?? '?'}: ${err.message ?? String(error)}`)
    process.exitCode = 1
  })
