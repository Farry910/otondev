/**
 * The gating question for this whole spike: can two peers sync on this machine, with the
 * credentials actually available here?
 *
 * Exit criteria 2 through 6 are all statements about two peers exchanging data. If sync cannot
 * start, none of them can be answered, and the spike's job becomes documenting exactly why —
 * with the observed error, not a docs citation. So this runs first and on its own.
 */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadDitto, runtimeNotes } from './runtime.js'
import { Peer, freshDir, logPeer } from './peer.js'
import { check, log } from './evidence.js'

const LICENCE = process.env['DITTO_OFFLINE_LICENSE_TOKEN']
const ROOT = join(tmpdir(), 'otondev-ditto-spike')
const PORT = 44_301

async function main(): Promise<number> {
  const { Ditto } = await loadDitto()
  log('sdk', `@dittolive/ditto ${Ditto.VERSION} on ${process.platform}-${process.arch}, node ${process.version}`, {
    sdkVersion: Ditto.VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  })

  if (runtimeNotes.noColorWasHazardous) {
    log('sdk.defect', `NO_COLOR=${runtimeNotes.originalNoColor} aborts the process at Ditto.open(); normalised to "false"`, {
      originalNoColor: runtimeNotes.originalNoColor,
    })
  }

  log('licence', LICENCE ? 'offline licence token supplied via DITTO_OFFLINE_LICENSE_TOKEN' : 'no offline licence token available')

  const alice = await Peer.open({ name: 'alice', dir: freshDir(ROOT, 'alice'), listenPort: PORT })
  const bob = await Peer.open({ name: 'bob', dir: freshDir(ROOT, 'bob'), connectTo: [`127.0.0.1:${PORT}`] })

  try {
    for (const peer of [alice, bob]) {
      const activation = peer.activate(LICENCE)
      log('activate', `${peer.name}: ${activation.detail}`, { peer: peer.name, ...activation })
    }

    const aliceSync = alice.startSync()
    const bobSync = bob.startSync()
    log('sync.start', `alice: ${aliceSync.detail}`, { peer: 'alice', ...aliceSync })
    log('sync.start', `bob: ${bobSync.detail}`, { peer: 'bob', ...bobSync })

    if (!aliceSync.started || !bobSync.started) {
      check(
        'sync convergence between two peers, including a concurrent update to the same record',
        'skipped',
        'both peers start sync and exchange a record',
        `sync.start() did not activate sync — alice: ${aliceSync.detail}; bob: ${bobSync.detail}`,
        { aliceSync, bobSync, hasLicence: Boolean(LICENCE) },
      )
      return 2
    }

    // Presence first: it distinguishes "connected but no data yet" from "never connected".
    const connected = await (async () => {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        if (alice.remotePeerCount > 0 && bob.remotePeerCount > 0) {
          return true
        }
        await new Promise((r) => setTimeout(r, 200))
      }
      return false
    })()

    logPeer(alice, connected ? 'sees a remote peer' : 'never saw a remote peer')
    logPeer(bob, connected ? 'sees a remote peer' : 'never saw a remote peer')

    alice.subscribe('SELECT * FROM memory')
    bob.subscribe('SELECT * FROM memory')

    await alice.execute('INSERT INTO memory DOCUMENTS (:doc)', {
      doc: { _id: 'cap-1', kind: 'fact', text: 'written on alice' },
    })

    const arrived = await bob.waitForRows(
      'SELECT * FROM memory WHERE _id = :id',
      { id: 'cap-1' },
      (rows) => rows.length === 1,
      20_000,
    )

    log('converge', arrived.ok ? `record reached bob in ${arrived.ms} ms` : 'record never reached bob', {
      ok: arrived.ok,
      ms: arrived.ms,
      presenceConnected: connected,
    })

    check(
      'two peers can sync at all on this machine (precondition for criteria 2-6)',
      arrived.ok ? 'pass' : 'fail',
      'a record inserted on peer A is readable on peer B',
      arrived.ok
        ? `arrived in ${arrived.ms} ms, presence connected=${connected}`
        : `did not arrive within ${arrived.ms} ms, presence connected=${connected}`,
      { ms: arrived.ms, presenceConnected: connected, hasLicence: Boolean(LICENCE) },
    )

    return arrived.ok ? 0 : 3
  } finally {
    await bob.close()
    await alice.close()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    const err = error as { name?: string; code?: string; message?: string; stack?: string }
    log('fatal', `${err.name ?? 'Error'}/${err.code ?? '?'}: ${err.message ?? String(error)}`, {
      name: err.name,
      code: err.code,
      message: err.message,
    })
    process.exitCode = 1
  })
