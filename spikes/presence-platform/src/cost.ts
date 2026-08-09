/**
 * Cost per meeting-hour, with every assumption stated and varied.
 *
 * The point of this file is not the headline number — it is the *spread*. Realtime voice
 * pricing is per audio token, and the Realtime API bills the accumulated conversation as input
 * on every response. Whether that accumulated audio is billed at the cached rate or the full
 * rate changes the answer by roughly 5x, and no amount of careful arithmetic resolves it from
 * the outside. Presenting a single figure would hide the only thing a decision-maker actually
 * needs to know.
 *
 * Published rates used (see FINDINGS.md for citations):
 *   input audio  : 1 token per 100 ms  = 600 tokens/minute
 *   output audio : 1 token per 50 ms   = 1200 tokens/minute
 */
import { log } from './evidence.js'

interface Model {
  name: string
  audioInPerM: number
  cachedAudioInPerM: number
  audioOutPerM: number
}

const MODELS: Model[] = [
  { name: 'gpt-realtime', audioInPerM: 32.0, cachedAudioInPerM: 0.40, audioOutPerM: 64.0 },
  { name: 'gpt-realtime-mini', audioInPerM: 10.0, cachedAudioInPerM: 0.30, audioOutPerM: 20.0 },
]

const INPUT_TOKENS_PER_MIN = 600
const OUTPUT_TOKENS_PER_MIN = 1200

interface Assumptions {
  meetingMinutes: number
  /** The agent hears the whole meeting: it cannot take turns on audio it never received. */
  listeningMinutes: number
  speakingMinutes: number
  /** Each spoken turn triggers a response, and a response bills the context so far. */
  turns: number
}

const BASE: Assumptions = {
  meetingMinutes: 60,
  listeningMinutes: 60,
  speakingMinutes: 6,
  turns: 12,
}

interface Breakdown {
  model: string
  scenario: string
  freshInput: number
  contextInput: number
  output: number
  total: number
}

/**
 * @param contextRate price per 1M tokens applied to re-sent conversation context
 */
function estimate(model: Model, a: Assumptions, contextRate: number, scenario: string): Breakdown {
  const freshInputTokens = a.listeningMinutes * INPUT_TOKENS_PER_MIN
  const outputTokens = a.speakingMinutes * OUTPUT_TOKENS_PER_MIN

  // Each response re-sends the conversation so far. Averaged over the meeting a turn sees
  // roughly half the total audio, so the accumulated re-billing is turns x half the stream.
  // This is an approximation, and deliberately a simple one: the uncertainty in the *rate*
  // dwarfs the error in the shape.
  const contextTokens = a.turns * (freshInputTokens / 2)

  const freshInput = (freshInputTokens / 1e6) * model.audioInPerM
  const contextInput = (contextTokens / 1e6) * contextRate
  const output = (outputTokens / 1e6) * model.audioOutPerM

  return {
    model: model.name,
    scenario,
    freshInput,
    contextInput,
    output,
    total: freshInput + contextInput + output,
  }
}

function money(value: number): string {
  return `$${value.toFixed(2)}`
}

function main(): void {
  log('cost.assumptions', `${BASE.meetingMinutes}-minute meeting, listening ${BASE.listeningMinutes} min, `
    + `speaking ${BASE.speakingMinutes} min across ${BASE.turns} turns`, BASE)

  const rows: Breakdown[] = []
  for (const model of MODELS) {
    rows.push(estimate(model, BASE, model.cachedAudioInPerM, 'context billed at the cached rate'))
    rows.push(estimate(model, BASE, model.audioInPerM, 'context billed at the full rate'))
  }

  console.log('')
  console.log('| model | context billing | fresh input | re-sent context | output | total / meeting-hour |')
  console.log('|---|---|---:|---:|---:|---:|')
  for (const row of rows) {
    console.log(`| ${row.model} | ${row.scenario} | ${money(row.freshInput)} | ${money(row.contextInput)} `
      + `| ${money(row.output)} | **${money(row.total)}** |`)
    log('cost.estimate', `${row.model} / ${row.scenario}: ${money(row.total)} per meeting-hour`, row)
  }
  console.log('')

  // Sensitivity on the one assumption a reader is most likely to dispute.
  console.log('Sensitivity — how much the agent speaks (gpt-realtime, cached context):')
  console.log('')
  console.log('| speaking minutes/hour | total / meeting-hour |')
  console.log('|---:|---:|')
  for (const speakingMinutes of [2, 6, 15, 30]) {
    const row = estimate(
      MODELS[0]!,
      { ...BASE, speakingMinutes, turns: Math.max(4, Math.round(speakingMinutes * 2)) },
      MODELS[0]!.cachedAudioInPerM,
      'sensitivity',
    )
    console.log(`| ${speakingMinutes} | ${money(row.total)} |`)
    log('cost.sensitivity', `speaking ${speakingMinutes} min/hour: ${money(row.total)}`, { speakingMinutes, ...row })
  }
  console.log('')
  console.log('Voice provider only. Meeting-platform and compute costs are separate — see FINDINGS.md.')
}

main()
