/**
 * Evidence recording, shared by the measuring parts of this spike.
 *
 * SP5 is mostly a research deliverable, so the few things that *can* be measured here carry
 * disproportionate weight — they are the only numbers in FINDINGS.md that are not somebody
 * else's published figure. They are therefore recorded raw, with sample counts, rather than
 * summarised into a single reassuring value.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const runId = process.env['OTONDEV_SPIKE_RUN'] ?? 'adhoc'
export const evidenceDir = process.env['OTONDEV_SPIKE_OUT'] ?? join(process.cwd(), 'evidence')

const logPath = join(evidenceDir, `events-${runId}.jsonl`)
mkdirSync(dirname(logPath), { recursive: true })

export function log(kind: string, msg: string, data?: unknown): void {
  const record = { ts: new Date().toISOString(), run: runId, kind, msg, ...(data === undefined ? {} : { data }) }
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
  console.log(`  ${kind.padEnd(20)} ${msg}`)
}

export interface Stats {
  n: number
  min: number
  p50: number
  p95: number
  max: number
  failures: number
}

/**
 * Percentiles from raw samples. p95 on a handful of samples is not a real p95, so the sample
 * count travels with the number everywhere it is reported — a latency figure without its `n`
 * invites exactly the over-reading this spike is supposed to prevent.
 */
export function summarise(samples: number[], failures: number): Stats {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number): number => sorted.length === 0
    ? Number.NaN
    : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN
  return {
    n: sorted.length,
    min: sorted[0] ?? Number.NaN,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    failures,
  }
}
