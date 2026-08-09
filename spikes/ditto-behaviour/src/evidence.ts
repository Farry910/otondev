/**
 * Evidence recording for the spike.
 *
 * Every claim FINDINGS.md makes has to trace to a line in here. Checks record what was
 * *observed* alongside what was expected, and a check that never ran is recorded as `skipped`
 * rather than silently omitted — a spike that reports only the tests it managed to run reads
 * as a pass when it is really a partial.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type CheckStatus = 'pass' | 'fail' | 'skipped'

export interface EvidenceEvent {
  ts: string
  ms: number
  run: string
  kind: string
  msg: string
  data?: unknown
}

export interface CheckRecord extends EvidenceEvent {
  kind: 'check'
  criterion: string
  status: CheckStatus
  expected: string
  observed: string
}

const started = Date.now()
export const runId = process.env['OTONDEV_SPIKE_RUN'] ?? 'adhoc'

export const evidenceDir = process.env['OTONDEV_SPIKE_OUT']
  ?? join(process.cwd(), 'evidence')

const logPath = join(evidenceDir, `events-${runId}.jsonl`)

mkdirSync(dirname(logPath), { recursive: true })

function append(record: EvidenceEvent): void {
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
}

export function log(kind: string, msg: string, data?: unknown): void {
  const record: EvidenceEvent = {
    ts: new Date().toISOString(),
    ms: Date.now() - started,
    run: runId,
    kind,
    msg,
    ...(data === undefined ? {} : { data }),
  }
  append(record)
  console.log(`  ${kind.padEnd(22)} ${msg}`)
}

/**
 * Record the outcome of one exit-criterion check.
 *
 * `criterion` is the card's wording, not a paraphrase, so the findings can be checked against
 * the card line by line.
 */
export function check(
  criterion: string,
  status: CheckStatus,
  expected: string,
  observed: string,
  data?: unknown,
): void {
  const record: CheckRecord = {
    ts: new Date().toISOString(),
    ms: Date.now() - started,
    run: runId,
    kind: 'check',
    criterion,
    status,
    expected,
    observed,
    msg: `${status.toUpperCase()} ${criterion}`,
    ...(data === undefined ? {} : { data }),
  }
  append(record)

  const mark = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'SKIP'
  console.log(`  [${mark}] ${criterion}`)
  console.log(`         expected: ${expected}`)
  console.log(`         observed: ${observed}`)
}

export function readEvidence(run?: string): EvidenceEvent[] {
  const target = join(evidenceDir, `events-${run ?? runId}.jsonl`)
  if (!existsSync(target)) {
    return []
  }
  return readFileSync(target, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as EvidenceEvent]
      } catch {
        // A run killed mid-write can leave a partial final line; losing it must not cost the rest.
        return []
      }
    })
}

/** Poll until `probe` returns true, or give up. Returns how long it took. */
export async function waitUntil(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<{ ok: boolean; ms: number }> {
  const begin = Date.now()
  for (;;) {
    if (await probe()) {
      return { ok: true, ms: Date.now() - begin }
    }
    if (Date.now() - begin >= timeoutMs) {
      return { ok: false, ms: Date.now() - begin }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
