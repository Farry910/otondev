/**
 * Voice-path measurement: round-trip latency, barge-in, and reconnect.
 *
 * Needs `OPENAI_API_KEY`. Without one it records each measurement as **skipped** with the
 * reason, and exits 2 — it never reports a number it did not measure.
 *
 * What it measures, and why each is defined this way:
 *
 *   round-trip  — from the moment the last input audio byte is committed to the first byte of
 *                 output audio. Not "response complete": a conversation feels responsive when
 *                 sound starts, and the design's turn-taking rules depend on that instant.
 *   barge-in    — from sending the interrupt to the last output audio byte actually received.
 *                 The presence design says "stop output promptly on interruption"; the number
 *                 that matters is how long the agent keeps talking over the human, so it is
 *                 measured at the audio, not at the acknowledgement.
 *   reconnect   — from socket close to a session that could carry a turn again. The presence
 *                 SLO is stated as recovery time, so this is the term that feeds it.
 */
import { log, summarise } from './evidence.js'

const API_KEY = process.env['OPENAI_API_KEY']
const MODEL = process.env['OTONDEV_VOICE_MODEL'] ?? 'gpt-realtime'
const ENDPOINT = `wss://api.openai.com/v1/realtime?model=${MODEL}`
const TURNS = Number(process.env['OTONDEV_SPIKE_TURNS'] ?? 5)

const MEASUREMENTS = ['round_trip_ms', 'barge_in_ms', 'reconnect_ms'] as const

function skipAll(reason: string): void {
  for (const measurement of MEASUREMENTS) {
    log('measure.skipped', `${measurement}: ${reason}`, { measurement, reason })
  }
}

/**
 * 24 kHz mono PCM16 silence with a short tone, base64-encoded — enough to make the provider
 * commit a turn. A real utterance would change the model's response but not the timing terms
 * being measured here.
 */
function syntheticUtterance(ms: number): string {
  const sampleRate = 24_000
  const samples = Math.floor((sampleRate * ms) / 1000)
  const buffer = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const value = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate))
    buffer.writeInt16LE(value, i * 2)
  }
  return buffer.toString('base64')
}

interface Session {
  socket: WebSocket
  ready: Promise<void>
}

function open(): Session {
  const socket = new WebSocket(ENDPOINT, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
  } as unknown as string[])

  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
  })

  return { socket, ready }
}

function send(socket: WebSocket, payload: unknown): void {
  socket.send(JSON.stringify(payload))
}

function now(): number {
  return Number(process.hrtime.bigint() / 1_000n) / 1000
}

async function measureTurns(): Promise<void> {
  const roundTrips: number[] = []
  const bargeIns: number[] = []
  let failures = 0

  const session = open()
  await session.ready
  log('voice.connected', `connected to ${MODEL}`)

  for (let turn = 0; turn < TURNS; turn++) {
    try {
      const firstAudio = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no audio within 15s')), 15_000)
        const onMessage = (event: MessageEvent): void => {
          const frame = JSON.parse(String(event.data)) as { type?: string }
          if (frame.type === 'response.output_audio.delta' || frame.type === 'response.audio.delta') {
            clearTimeout(timer)
            session.socket.removeEventListener('message', onMessage)
            resolve(now())
          }
        }
        session.socket.addEventListener('message', onMessage)
      })

      send(session.socket, { type: 'input_audio_buffer.append', audio: syntheticUtterance(800) })
      send(session.socket, { type: 'input_audio_buffer.commit' })
      const committed = now()
      send(session.socket, { type: 'response.create' })

      roundTrips.push((await firstAudio) - committed)

      // Barge-in: interrupt mid-response and time until audio actually stops arriving.
      const interruptedAt = now()
      send(session.socket, { type: 'response.cancel' })
      let lastAudioAt = interruptedAt
      await new Promise<void>((resolve) => {
        const onMessage = (event: MessageEvent): void => {
          const frame = JSON.parse(String(event.data)) as { type?: string }
          if (frame.type?.includes('audio.delta')) {
            lastAudioAt = now()
          }
        }
        session.socket.addEventListener('message', onMessage)
        setTimeout(() => {
          session.socket.removeEventListener('message', onMessage)
          resolve()
        }, 2_000)
      })
      bargeIns.push(lastAudioAt - interruptedAt)
    } catch (error) {
      failures++
      log('voice.turn.failed', `turn ${turn}: ${(error as Error).message}`)
    }
  }

  session.socket.close()

  const rt = summarise(roundTrips, failures)
  const bi = summarise(bargeIns, failures)
  log('measure.round_trip_ms', `commit to first output audio: p50 ${rt.p50.toFixed(0)} ms (n=${rt.n})`, rt)
  log('measure.barge_in_ms', `interrupt to last output audio: p50 ${bi.p50.toFixed(0)} ms (n=${bi.n})`, bi)
}

async function measureReconnect(): Promise<void> {
  const samples: number[] = []
  let failures = 0

  for (let i = 0; i < 3; i++) {
    try {
      const began = now()
      const session = open()
      await session.ready
      samples.push(now() - began)
      session.socket.close()
    } catch (error) {
      failures++
      log('voice.reconnect.failed', (error as Error).message)
    }
  }

  const stats = summarise(samples, failures)
  log('measure.reconnect_ms', `socket open to session ready: p50 ${stats.p50.toFixed(0)} ms (n=${stats.n})`, stats)
}

async function main(): Promise<number> {
  if (!API_KEY) {
    skipAll('OPENAI_API_KEY is not set; no voice provider session could be established')
    log('voice.blocked', 'set OPENAI_API_KEY and re-run: npm run voice')
    return 2
  }

  log('voice.begin', `measuring ${TURNS} turns against ${MODEL}`)
  await measureTurns()
  await measureReconnect()
  return 0
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error: unknown) => {
    log('fatal', (error as Error).message)
    process.exitCode = 1
  })
