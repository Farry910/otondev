/**
 * A Ditto peer, wired for a controlled two-peer experiment on one machine.
 *
 * Transport policy here is deliberate and restrictive. Every discovery mechanism Ditto enables
 * by default — Bluetooth LE, AWDL, Wi-Fi Aware, mDNS and multicast on the LAN — is turned
 * *off*, and the two peers are introduced to each other by an explicit `127.0.0.1:port`. Two
 * reasons, both load-bearing:
 *
 *   - A spike must not broadcast a synthetic memory database onto whatever network the
 *     developer happens to be on, or discover a stranger's peer and sync with it.
 *   - Discovery is a source of nondeterminism. "The peers did not converge" has to mean the
 *     CRDT did not converge, not that mDNS was slow, or the findings are worthless.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadDitto } from './runtime.js'
import { log, waitUntil } from './evidence.js'
import type { Ditto, QueryResult, DQLQueryArguments } from '@dittolive/ditto'

/** Shared by both peers: peers only sync when their database ID matches. */
export const DATABASE_ID = '0f3d5b0e-6a1b-4c2f-9f77-1a0f2c3d4e5b'

export interface PeerOptions {
  name: string
  dir: string
  /** If set, this peer listens for TCP connections here. */
  listenPort?: number
  /** `host:port` entries this peer dials. */
  connectTo?: string[]
  /** Shared secret for peer authentication. Peers with different keys must not connect. */
  privateKey?: string | null
  /** Distinct database IDs let a test prove that unrelated databases never mesh. */
  databaseID?: string
}

export class Peer {
  private constructor(
    readonly name: string,
    readonly ditto: Ditto,
    readonly dir: string,
  ) {}

  static async open(options: PeerOptions): Promise<Peer> {
    const { Ditto: DittoClass, DittoConfig } = await loadDitto()
    mkdirSync(options.dir, { recursive: true })

    const config = new DittoConfig(
      options.databaseID ?? DATABASE_ID,
      { mode: 'smallPeersOnly', privateKey: options.privateKey ?? null },
      options.dir,
    )

    const ditto = await DittoClass.open(config)
    ditto.deviceName = options.name

    ditto.updateTransportConfig((transport) => {
      transport.peerToPeer.bluetoothLE.isEnabled = false
      transport.peerToPeer.awdl.isEnabled = false
      transport.peerToPeer.wifiAware.isEnabled = false
      transport.peerToPeer.lan.isEnabled = false
      transport.peerToPeer.lan.isMdnsEnabled = false
      transport.peerToPeer.lan.isMulticastEnabled = false

      transport.connect.tcpServers = options.connectTo ?? []
      transport.connect.websocketURLs = []
      transport.connect.retryInterval = 500

      if (options.listenPort !== undefined) {
        transport.listen.tcp.isEnabled = true
        transport.listen.tcp.interfaceIP = '127.0.0.1'
        transport.listen.tcp.port = options.listenPort
      } else {
        transport.listen.tcp.isEnabled = false
      }
      transport.listen.http.isEnabled = false
    })

    return new Peer(options.name, ditto, options.dir)
  }

  /**
   * Activate with an offline licence token if one is available.
   *
   * Returns what happened rather than throwing, because "sync could not be activated" is a
   * finding this spike has to report precisely, not an error to crash on.
   */
  activate(token: string | undefined): { activated: boolean; detail: string } {
    if (!token) {
      return { activated: false, detail: 'no offline licence token supplied' }
    }
    try {
      this.ditto.setOfflineOnlyLicenseToken(token)
      return {
        activated: this.ditto.isActivated,
        detail: this.ditto.isActivated ? 'activated with offline licence token' : 'token accepted but isActivated is false',
      }
    } catch (error) {
      const err = error as { name?: string; code?: string; message?: string }
      return { activated: false, detail: `${err.name ?? 'Error'}/${err.code ?? '?'}: ${err.message ?? String(error)}` }
    }
  }

  startSync(): { started: boolean; detail: string } {
    try {
      this.ditto.sync.start()
      return { started: this.ditto.sync.isActive, detail: 'sync.start() returned normally' }
    } catch (error) {
      const err = error as { name?: string; code?: string; message?: string }
      return { started: false, detail: `${err.name ?? 'Error'}/${err.code ?? '?'}: ${err.message ?? String(error)}` }
    }
  }

  stopSync(): void {
    this.ditto.sync.stop()
  }

  subscribe(query: string, args?: DQLQueryArguments) {
    return this.ditto.sync.registerSubscription(query, args)
  }

  execute<T = Record<string, unknown>>(query: string, args?: DQLQueryArguments): Promise<QueryResult<T>> {
    return this.ditto.store.execute<T>(query, args)
  }

  /** Rows as plain objects, which is all the assertions in this spike need. */
  async rows<T = Record<string, unknown>>(query: string, args?: DQLQueryArguments): Promise<T[]> {
    const result = await this.execute<T>(query, args)
    return result.items.map((item) => item.value as T)
  }

  async count(query: string, args?: DQLQueryArguments): Promise<number> {
    return (await this.rows(query, args)).length
  }

  /** Wait for a query on this peer to return rows satisfying `predicate`. */
  waitForRows<T = Record<string, unknown>>(
    query: string,
    args: DQLQueryArguments | undefined,
    predicate: (rows: T[]) => boolean,
    timeoutMs = 15_000,
  ): Promise<{ ok: boolean; ms: number }> {
    return waitUntil(async () => predicate(await this.rows<T>(query, args)), timeoutMs)
  }

  get peerKey(): string {
    try {
      return this.ditto.presence.graph.localPeer.peerKey || '<unknown>'
    } catch {
      return '<unavailable>'
    }
  }

  /**
   * How many remote peers this peer can currently see. This is the honest signal for "are they
   * actually connected" — a converged query could also be explained by both peers having
   * written the same value locally, whereas presence cannot.
   */
  get remotePeerCount(): number {
    try {
      return this.ditto.presence.graph.remotePeers.length
    } catch {
      return 0
    }
  }

  async close(): Promise<void> {
    try {
      this.ditto.sync.stop()
    } catch {
      // Sync may never have started; closing is still correct.
    }
    await this.ditto.close()
  }
}

/** A fresh, isolated directory per peer per run — stale state would silently fake convergence. */
export function freshDir(root: string, name: string): string {
  const dir = join(root, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

export function logPeer(peer: Peer, note: string): void {
  log('peer', `${peer.name}: ${note}`, {
    peer: peer.name,
    isActivated: peer.ditto.isActivated,
    syncActive: peer.ditto.sync.isActive,
    remotePeers: peer.remotePeerCount,
    dir: peer.dir,
  })
}
