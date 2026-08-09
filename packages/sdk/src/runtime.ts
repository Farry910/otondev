import { randomFillSync } from 'node:crypto';
import { ID_PREFIX, ulid } from '@otondev/contracts';
import type { Clock, IdFactory, IdKind } from '@otondev/contracts';

/**
 * Production implementations of the two things every service needs and neither should reach
 * for ambiently: the clock and the ID generator.
 *
 * They live here rather than in the testkit because a production package may not import a
 * test double (`no-testkit-in-production-code`), and they are injected rather than imported
 * at the point of use because every deadline in this system — lease expiry, approval expiry,
 * capability expiry, wakeup scheduling — is a rule that has to be testable.
 */

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  /** RFC3339 UTC without milliseconds, matching the `Rfc3339Utc` contract. */
  nowIso: () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};

/** Cryptographically random ULIDs. The testkit's deterministic factory is the test twin. */
export function createIdFactory(clock: Clock = systemClock): IdFactory {
  const buffer = new Uint8Array(10);
  return {
    next(kind: IdKind): string {
      randomFillSync(buffer);
      return ID_PREFIX[kind] + ulid(clock.nowMs(), buffer);
    },
  };
}

/**
 * What every fake and every real service is constructed with.
 *
 * A service that takes this is testable by construction: hand it the testkit's `FakeClock`
 * and `deterministicIdFactory` and the same code runs deterministically.
 */
export interface RuntimeContext {
  clock: Clock;
  ids: IdFactory;
}

export function createRuntimeContext(clock: Clock = systemClock): RuntimeContext {
  return { clock, ids: createIdFactory(clock) };
}
