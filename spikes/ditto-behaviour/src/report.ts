/**
 * Renders the recorded evidence as markdown.
 *
 * Reads only what the runs wrote. Checks that were skipped are printed as skipped rather than
 * dropped, because the difference between "this passed" and "this never ran" is the whole
 * value of the report to whoever decides the gate.
 */
import { writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { evidenceDir, readEvidence, type EvidenceEvent, type CheckRecord } from './evidence.js'

const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const outPath = outIndex >= 0 ? argv[outIndex + 1] : undefined
// Drop both the flag and its value, or the output path gets mistaken for a run id and the
// report claims to cover a run that does not exist.
const runs = argv.filter((a, i) => !a.startsWith('--') && i !== outIndex + 1)

const discovered = runs.length > 0
  ? runs
  : readdirSync(evidenceDir)
      .filter((f) => f.startsWith('events-') && f.endsWith('.jsonl'))
      .map((f) => f.slice('events-'.length, -'.jsonl'.length))

const events: EvidenceEvent[] = discovered.flatMap((run) => readEvidence(run))
const checks = events.filter((e): e is CheckRecord => e.kind === 'check')

const lines: string[] = []
const w = (text = '') => lines.push(text)

w('# Ditto behaviour spike — measured evidence')
w()
w(`- runs: ${discovered.map((r) => `\`${r}\``).join(', ')}`)
w(`- events: **${events.length}**, checks: **${checks.length}**`)

const sdk = events.find((e) => e.kind === 'sdk')
if (sdk) {
  w(`- environment: ${sdk.msg}`)
}
w()

w('## Exit-criterion checks')
w()
w('| status | criterion | observed |')
w('|---|---|---|')
for (const c of checks) {
  const mark = c.status === 'pass' ? 'PASS' : c.status === 'fail' ? '**FAIL**' : '_skipped_'
  w(`| ${mark} | ${c.criterion} | ${c.observed.replace(/\|/g, '\\|')} |`)
}
w()

const pass = checks.filter((c) => c.status === 'pass').length
const fail = checks.filter((c) => c.status === 'fail').length
const skip = checks.filter((c) => c.status === 'skipped').length
w(`**${pass} passed, ${fail} failed, ${skip} skipped.** A skipped check is an unanswered question, not a pass.`)
w()

const capabilities = events.filter((e) => e.kind === 'dql.capability')
if (capabilities.length > 0) {
  w('## DQL capability sweep')
  w()
  w('| MemoryStore need | expressible | statement |')
  w('|---|---|---|')
  for (const cap of capabilities) {
    const d = cap.data as { need: string; statement: string; ok: boolean; error?: string }
    w(`| ${d.need} | ${d.ok ? 'yes' : `**no** — ${d.error ?? 'rejected'}`} | \`${d.statement}\` |`)
  }
  w()
}

const notable = events.filter((e) =>
  e.kind === 'sdk.defect' || e.kind === 'sync.start' || e.kind === 'dql.removal'
  || e.kind === 'dql.tombstone_visibility' || e.kind === 'dql.conditional_write' || e.kind === 'licence')
if (notable.length > 0) {
  w('## Notable observations')
  w()
  for (const e of notable) {
    w(`- \`${e.kind}\` — ${e.msg}`)
  }
  w()
}

const text = lines.join('\n')
console.log(text)

const target = outPath ?? join(evidenceDir, 'evidence.md')
writeFileSync(target, text, 'utf8')
console.error(`written to ${target}`)
