/**
 * Loads the Ditto SDK safely and quietly.
 *
 * Two things have to happen before the native addon initialises, which is why this is a
 * function returning a dynamic import rather than a plain top-level `import`:
 *
 * 1. `NO_COLOR` has to be normalised. Ditto 5.0.3's Rust logging config accepts only `true` or
 *    `false` for its colour flag, but maps the conventional `NO_COLOR=1` straight through. The
 *    result is a Rust panic inside a `nounwind` FFI boundary — the Node process aborts at
 *    `Ditto.open()` with a stack trace and no catchable error. `NO_COLOR=1` is the norm in CI,
 *    so this is a live integration hazard, not a local quirk.
 *
 * 2. Logging has to be turned down. The SDK defaults to trace-level logging on stderr, which
 *    buries the spike's own output and makes measured timings noisy.
 *
 * ESM hoists static imports above all statements, so setting `process.env` at module top level
 * would still run *after* `@dittolive/ditto` had been loaded. Hence the dynamic import.
 */
export type DittoModule = typeof import('@dittolive/ditto')

let cached: DittoModule | undefined

export interface RuntimeNotes {
  noColorWasHazardous: boolean
  originalNoColor: string | undefined
}

export const runtimeNotes: RuntimeNotes = {
  noColorWasHazardous: false,
  originalNoColor: undefined,
}

export async function loadDitto(options: { verbose?: boolean } = {}): Promise<DittoModule> {
  if (cached) {
    return cached
  }

  const noColor = process.env['NO_COLOR']
  runtimeNotes.originalNoColor = noColor
  if (noColor !== undefined && noColor !== 'true' && noColor !== 'false') {
    runtimeNotes.noColorWasHazardous = true
    process.env['NO_COLOR'] = 'false'
  }

  const ditto = await import('@dittolive/ditto')

  if (!options.verbose) {
    ditto.Logger.minimumLogLevel = 'Error'
    ditto.Logger.enabled = false
  }

  cached = ditto
  return cached
}
