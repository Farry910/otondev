import type { Clock, IdFactory } from './index-types.js';

/**
 * The shape of a conformance suite.
 *
 * Lives in `contracts` rather than in `testkit` for a boundary reason that turns out to be a
 * design reason. A suite for the Policy interface has to be *authored* next to that
 * interface, in `packages/sdk`, and `packages/sdk` is production code that may not import a
 * test double. If the suite type came from `testkit`, either the rule or the suite would
 * have to give way.
 *
 * Splitting it here resolves that honestly: **a suite is data**, and running it is a
 * separate concern. `packages/sdk` declares suites; `packages/testkit` runs them and drives
 * fake-parity comparisons. Neither imports the other.
 */

/**
 * What a case may do to the world it runs in. Deliberately narrow: a suite that could reach
 * the real clock or the real network would give two subjects different verdicts for reasons
 * neither of them caused.
 */
export interface FaultControl {
  /** Fail the next `times` calls to `operation` with `code`. */
  failNext(operation: string, code: string, times?: number): unknown;
  /** The ambiguous outcome: the caller cannot tell whether the effect happened. */
  timeoutNext(operation: string, times?: number): unknown;
  /** Advance the clock by `ms` before the call proceeds, expiring leases and capabilities. */
  delayNext(operation: string, ms: number, times?: number): unknown;
  /** Never return. */
  hangNext(operation: string, times?: number): unknown;
  callCount(operation: string): number;
}

export interface ConformanceContext {
  clock: Clock;
  ids: IdFactory;
  faults: FaultControl;
  /** Move the injected clock forward. The only way a case may make time pass. */
  advance(ms: number): void;
}

export interface ConformanceCase<S> {
  name: string;
  /**
   * Capabilities the case needs. A subject that does not declare them is **skipped**, and
   * the skip is reported — never silently counted as a pass. Same rule the verifier lives
   * under (S12: "'skipped' is never reported as pass") and for the same reason.
   */
  requires?: readonly string[];
  run(subject: S, context: ConformanceContext): void | Promise<void>;
}

export interface ConformanceSuite<S> {
  name: string;
  cases: readonly ConformanceCase<S>[];
}

export function defineConformanceSuite<S>(
  name: string,
  cases: readonly ConformanceCase<S>[],
): ConformanceSuite<S> {
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (seen.has(testCase.name)) {
      // Two cases with one name make the parity report ambiguous: a divergence could not be
      // attributed to either of them.
      throw new Error(`conformance suite "${name}" has two cases named "${testCase.name}"`);
    }
    seen.add(testCase.name);
  }
  return { name, cases };
}

/** Assert inside a conformance case. Throwing is how a case reports failure to the runner. */
export function expectTrue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function expectEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

/** Assert that `fn` rejects, optionally with a specific error code. */
export async function expectRejection(fn: () => Promise<unknown>, code?: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (code === undefined) return;
    const actual =
      error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    if (actual !== code) throw new Error(`expected rejection with ${code}, got ${actual ?? String(error)}`);
    return;
  }
  throw new Error(`expected a rejection${code === undefined ? '' : ` with ${code}`}, but it resolved`);
}
