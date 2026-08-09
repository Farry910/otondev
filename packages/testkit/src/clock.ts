import type { Clock } from '@otondev/contracts';

/**
 * A clock the test controls, with timers.
 *
 * Nearly every invariant in this system is a deadline: a lease expires, an approval expires,
 * a capability expires, a workflow wakes up, an emergency deny must propagate at p95 under
 * ten seconds. Testing those against the real clock means sleeping, and a suite that sleeps
 * is a suite people stop running. Testing them against a clock the test advances by hand is
 * exact and instant.
 */

export interface FakeTimer {
  id: number;
  dueAtMs: number;
  callback: () => void;
  intervalMs: number | null;
}

export class FakeClock implements Clock {
  #ms: number;
  #nextTimerId = 1;
  #timers = new Map<number, FakeTimer>();

  constructor(start: string | number | Date = '2026-07-30T08:00:00.000Z') {
    this.#ms = typeof start === 'number' ? start : new Date(start).getTime();
    if (Number.isNaN(this.#ms)) throw new TypeError(`FakeClock: invalid start time ${String(start)}`);
  }

  nowMs(): number {
    return this.#ms;
  }

  nowIso(): string {
    return new Date(this.#ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** With milliseconds, for anything that needs sub-second ordering. */
  nowIsoPrecise(): string {
    return new Date(this.#ms).toISOString();
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.#nextTimerId++;
    this.#timers.set(id, { id, dueAtMs: this.#ms + Math.max(0, delayMs), callback, intervalMs: null });
    return id;
  }

  setInterval(callback: () => void, everyMs: number): number {
    if (everyMs <= 0) throw new RangeError('FakeClock: interval must be positive');
    const id = this.#nextTimerId++;
    this.#timers.set(id, { id, dueAtMs: this.#ms + everyMs, callback, intervalMs: everyMs });
    return id;
  }

  clearTimer(id: number): void {
    this.#timers.delete(id);
  }

  get pendingTimers(): number {
    return this.#timers.size;
  }

  /**
   * Move time forward, firing every timer that comes due *at the moment it comes due* rather
   * than all at the end. A timer scheduled by another timer therefore sees the correct
   * `nowMs()`, which is what makes a retry-with-backoff test mean anything.
   */
  advance(byMs: number): void {
    if (byMs < 0) throw new RangeError('FakeClock: time does not run backwards');
    const target = this.#ms + byMs;
    // Bounded so a self-rescheduling timer fails the test instead of hanging CI.
    for (let fired = 0; fired < 10_000; fired += 1) {
      const next = this.#earliestDue(target);
      if (next === undefined) break;
      this.#ms = next.dueAtMs;
      if (next.intervalMs === null) this.#timers.delete(next.id);
      else next.dueAtMs = this.#ms + next.intervalMs;
      next.callback();
    }
    if (this.#earliestDue(target) !== undefined) {
      throw new Error('FakeClock: 10000 timers fired without reaching the target time');
    }
    this.#ms = target;
  }

  advanceTo(when: string | number | Date): void {
    const target = typeof when === 'number' ? when : new Date(when).getTime();
    this.advance(target - this.#ms);
  }

  /** Fire everything outstanding, whenever it is due. */
  runAllTimers(): void {
    for (let i = 0; i < 10_000 && this.#timers.size > 0; i += 1) {
      const soonest = [...this.#timers.values()].reduce((a, b) => (b.dueAtMs < a.dueAtMs ? b : a));
      this.advanceTo(soonest.dueAtMs);
      if (this.#timers.has(soonest.id) && soonest.dueAtMs <= this.#ms && soonest.intervalMs === null) {
        // advance() already fired it; guard against a timer scheduled at exactly `now`.
        this.#timers.delete(soonest.id);
      }
    }
  }

  #earliestDue(limitMs: number): FakeTimer | undefined {
    let earliest: FakeTimer | undefined;
    for (const timer of this.#timers.values()) {
      if (timer.dueAtMs > limitMs) continue;
      if (earliest === undefined || timer.dueAtMs < earliest.dueAtMs || (timer.dueAtMs === earliest.dueAtMs && timer.id < earliest.id)) {
        earliest = timer;
      }
    }
    return earliest;
  }
}

/** The real clock, for anything that is not a test. */
export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};
