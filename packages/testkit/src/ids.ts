import { ID_PREFIX, ulid } from '@otondev/contracts';
import type { Clock, IdFactory, IdKind } from '@otondev/contracts';

/**
 * Deterministic identifiers.
 *
 * Two properties matter and they pull against each other. Golden files and evidence digests
 * need the same input to produce the same ID every run. Dedupe, ordering and lease fencing
 * need IDs that are genuinely distinct and time-ordered. Both hold here: the ULID timestamp
 * comes from the injected clock and the 80-bit tail is a counter, so a run replays exactly
 * and no two IDs collide.
 *
 * The generator uses the same `ulid()` from `@otondev/contracts` that production uses.
 * A test double with its own ID encoding would pass tests that the real format fails.
 */
export interface DeterministicIdOptions {
  clock: Clock;
  /** Distinguishes two generators in the same test so their sequences do not interleave. */
  seed?: number;
}

export function deterministicIdFactory(options: DeterministicIdOptions): IdFactory & {
  /** How many IDs have been minted, per kind. Useful for asserting a code path ran once. */
  counts(): Readonly<Record<string, number>>;
  reset(): void;
} {
  const seed = options.seed ?? 0;
  let counter = 0;
  const counts: Record<string, number> = {};

  return {
    next(kind: IdKind): string {
      counter += 1;
      counts[kind] = (counts[kind] ?? 0) + 1;
      const randomness = new Uint8Array(10);
      // Seed in the high bytes, counter in the low: two factories never collide, and the
      // sequence within one factory is strictly increasing.
      randomness[0] = (seed >> 8) & 0xff;
      randomness[1] = seed & 0xff;
      randomness[6] = (counter >>> 24) & 0xff;
      randomness[7] = (counter >>> 16) & 0xff;
      randomness[8] = (counter >>> 8) & 0xff;
      randomness[9] = counter & 0xff;
      return ID_PREFIX[kind] + ulid(options.clock.nowMs(), randomness);
    },
    counts() {
      return { ...counts };
    },
    reset() {
      counter = 0;
      for (const key of Object.keys(counts)) delete counts[key];
    },
  };
}

/**
 * A random production generator, for the SDK to re-export. Lives here next to the
 * deterministic one so the two encodings cannot drift apart unnoticed.
 */
export function randomIdFactory(clock: Clock, randomBytes: (n: number) => Uint8Array): IdFactory {
  return {
    next: (kind: IdKind) => ID_PREFIX[kind] + ulid(clock.nowMs(), randomBytes(10)),
  };
}
