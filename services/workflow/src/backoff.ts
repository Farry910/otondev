/**
 * Retry and backoff for interrupted attempts.
 *
 * Deterministic by default. Jitter is a real production need — it stops a fleet of workers
 * retrying in lockstep after a shared outage — but it is supplied as an injected function
 * rather than read from `Math.random()`, because a backoff schedule nobody can reproduce is a
 * backoff schedule nobody can debug when it turns out to be the cause of an incident.
 */

export interface BackoffPolicy {
  /** Delay before attempt 2. Attempt 1 is the original try and is never delayed. */
  baseMs: number;
  /** Multiplier per attempt. */
  factor: number;
  /** Ceiling, applied before jitter. */
  maxMs: number;
  /** Attempts beyond this do not get a wakeup; the workflow is out of road. */
  maxAttempts: number;
  /**
   * Returns a value in [0, 1). Defaults to 0 — no jitter, fully reproducible.
   * Production wires this to a PRNG seeded per worker.
   */
  jitter?: () => number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 5 * 60_000,
  maxAttempts: 5,
};

/**
 * Delay before `attempt`, where attempt 1 is the first try.
 *
 * Returns null when the policy is exhausted, which the engine reads as "stop scheduling
 * wakeups and let this fail" rather than "retry immediately" — the failure mode a `0` return
 * would have produced.
 */
export function delayForAttempt(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number | null {
  if (attempt <= 1) return 0;
  if (attempt > policy.maxAttempts) return null;

  const exponent = attempt - 2;
  const raw = policy.baseMs * Math.pow(policy.factor, exponent);
  const capped = Math.min(raw, policy.maxMs);

  // Full jitter over [capped/2, capped]: keeps the growth curve while spreading the herd.
  const jitter = policy.jitter?.() ?? 0;
  return Math.round(capped / 2 + (capped / 2) * jitter);
}

/** The wakeup instant for `attempt`, or null when the policy is exhausted. */
export function nextWakeupAt(
  attempt: number,
  nowMs: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
): string | null {
  const delay = delayForAttempt(attempt, policy);
  if (delay === null) return null;
  return new Date(nowMs + delay).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
