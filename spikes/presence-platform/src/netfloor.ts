/**
 * The credential-free part of the voice-path measurement.
 *
 * A spoken turn cannot be faster than the network round trip to the voice provider, and that
 * floor is measurable without any API key: DNS, TCP connect, and TLS handshake to the
 * provider's real endpoint from the real network the agent would sit on. Everything the
 * provider then adds — inference, generation, buffering — stacks on top of this number.
 *
 * This is deliberately *not* presented as end-to-end voice latency. It is the term of the
 * budget that no amount of provider tuning can remove, which is why it is worth having even
 * when the rest of the measurement is blocked on credentials.
 *
 * TLS handshake is reported separately from TCP connect because they behave differently under
 * reconnect: a session resumption skips most of the handshake, so a reconnect budget built on
 * full-handshake numbers is pessimistic and one built on TCP alone is optimistic.
 */
import { connect as tlsConnect } from 'node:tls'
import { connect as tcpConnect } from 'node:net'
import { lookup } from 'node:dns/promises'
import { log, summarise } from './evidence.js'

interface Target {
  name: string
  host: string
  port: number
  role: string
}

/**
 * Endpoints the presence design would actually talk to. Meeting-platform hosts are included
 * alongside the voice provider because the agent's audio traverses both: a meeting media path
 * to a distant region costs the conversation just as much as a slow model.
 */
const TARGETS: Target[] = [
  { name: 'openai-api', host: 'api.openai.com', port: 443, role: 'voice provider (OpenAI Realtime)' },
  { name: 'zoom-rtms', host: 'zoom.us', port: 443, role: 'meeting platform control plane (Zoom)' },
  { name: 'teams-graph', host: 'graph.microsoft.com', port: 443, role: 'meeting platform control plane (Teams/Graph)' },
  { name: 'google-meet', host: 'meet.google.com', port: 443, role: 'meeting platform control plane (Google Meet)' },
]

const SAMPLES = Number(process.env['OTONDEV_SPIKE_SAMPLES'] ?? 10)

function now(): number {
  return Number(process.hrtime.bigint() / 1_000n) / 1000
}

function timeTcp(host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const began = now()
    const socket = tcpConnect({ host, port })
    socket.setTimeout(8_000)
    socket.once('connect', () => {
      const ms = now() - began
      socket.destroy()
      resolve(ms)
    })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('tcp timeout')) })
    socket.once('error', (error) => { socket.destroy(); reject(error) })
  })
}

function timeTls(host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const began = now()
    const socket = tlsConnect({ host, port, servername: host })
    socket.setTimeout(8_000)
    socket.once('secureConnect', () => {
      const ms = now() - began
      socket.destroy()
      resolve(ms)
    })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('tls timeout')) })
    socket.once('error', (error) => { socket.destroy(); reject(error) })
  })
}

async function measure(target: Target): Promise<void> {
  let address = '<unresolved>'
  try {
    const resolved = await lookup(target.host)
    address = resolved.address
  } catch (error) {
    log('netfloor.dns.failed', `${target.name}: ${(error as Error).message}`)
    return
  }

  const tcp: number[] = []
  const tls: number[] = []
  let failures = 0

  for (let i = 0; i < SAMPLES; i++) {
    try {
      tcp.push(await timeTcp(target.host, target.port))
      tls.push(await timeTls(target.host, target.port))
    } catch (error) {
      failures++
      if (failures === 1) {
        log('netfloor.error', `${target.name}: ${(error as Error).message}`)
      }
    }
    // Space the samples so a burst does not just measure one warm path.
    await new Promise((r) => setTimeout(r, 120))
  }

  const tcpStats = summarise(tcp, failures)
  const tlsStats = summarise(tls, failures)

  log('netfloor.result',
    `${target.name.padEnd(12)} tcp p50 ${tcpStats.p50.toFixed(1)} ms · tls p50 ${tlsStats.p50.toFixed(1)} ms (n=${tcpStats.n})`,
    { target: target.name, host: target.host, address, role: target.role, tcp: tcpStats, tls: tlsStats })
}

async function main(): Promise<void> {
  log('netfloor.begin', `measuring the network floor, ${SAMPLES} samples per target`, {
    samples: SAMPLES,
    note: 'this is the irreducible term of the voice budget, not end-to-end voice latency',
  })

  for (const target of TARGETS) {
    await measure(target)
  }

  log('netfloor.done', 'network floor measured')
}

main().catch((error: unknown) => {
  log('fatal', (error as Error).message)
  process.exitCode = 1
})
