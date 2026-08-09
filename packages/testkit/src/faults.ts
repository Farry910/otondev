import { ContractError, makeError } from '@otondev/contracts';
import type { Clock, ErrorCode } from '@otondev/contracts';

/**
 * Fault injection.
 *
 * The exit criteria that matter most in this architecture are all about what happens when
 * something goes wrong halfway: "crash between persist and ack does not lose or duplicate an
 * acknowledged event", "crash mid-transition resumes at a safe state", "an ambiguous timeout
 * sets outcome_unknown". None of those can be tested by calling the happy path. They need a
 * peer that fails on the third call, or hangs, or returns after the lease expired.
 *
 * Faults are declared per operation name and consumed in order, so a test reads as a
 * sequence of events rather than a pile of mock configuration.
 */

export type FaultKind = 'error' | 'delay' | 'hang' | 'timeout';

export interface Fault {
  kind: FaultKind;
  /** For `error` and `timeout`. */
  code?: ErrorCode;
  /** For `delay`: how far to advance the injected clock before returning normally. */
  delayMs?: number;
  /** How many further calls this fault applies to. `Infinity` for always. */
  remaining: number;
}

export interface FaultInjectorOptions {
  clock: Clock;
  /** Advances the clock for `delay` faults. Omit and a delay only records, never advances. */
  advance?: (ms: number) => void;
}

export class FaultInjector {
  #faults = new Map<string, Fault[]>();
  #calls = new Map<string, number>();
  readonly #clock: Clock;
  readonly #advance: ((ms: number) => void) | undefined;

  constructor(options: FaultInjectorOptions) {
    this.#clock = options.clock;
    this.#advance = options.advance;
  }

  /** Fail the next `times` calls to `operation` with `code`. */
  failNext(operation: string, code: ErrorCode, times = 1): this {
    return this.#push(operation, { kind: 'error', code, remaining: times });
  }

  /** Fail every call to `operation` until cleared. */
  failAlways(operation: string, code: ErrorCode): this {
    return this.#push(operation, { kind: 'error', code, remaining: Number.POSITIVE_INFINITY });
  }

  /**
   * The ambiguous-timeout case, which is its own kind rather than an error because the
   * caller must be able to tell "it definitely failed" from "I do not know" — the whole
   * point of `outcome_unknown` (contracts §7).
   */
  timeoutNext(operation: string, times = 1): this {
    return this.#push(operation, { kind: 'timeout', code: 'TIMEOUT', remaining: times });
  }

  /** Advance the clock by `ms` before the call proceeds. Expires leases and capabilities. */
  delayNext(operation: string, ms: number, times = 1): this {
    return this.#push(operation, { kind: 'delay', delayMs: ms, remaining: times });
  }

  /** Never return. The returned promise stays pending forever. */
  hangNext(operation: string, times = 1): this {
    return this.#push(operation, { kind: 'hang', remaining: times });
  }

  clear(operation?: string): void {
    if (operation === undefined) this.#faults.clear();
    else this.#faults.delete(operation);
  }

  /** How many times `operation` has been called, faults included. */
  callCount(operation: string): number {
    return this.#calls.get(operation) ?? 0;
  }

  calls(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.#calls);
  }

  /** Faults that were declared and never consumed — usually a test that did not do what it says. */
  unconsumed(): string[] {
    const left: string[] = [];
    for (const [operation, faults] of this.#faults) {
      const count = faults.reduce((n, f) => n + (Number.isFinite(f.remaining) ? f.remaining : 0), 0);
      if (count > 0) left.push(`${operation} (${count})`);
    }
    return left;
  }

  /**
   * Consult the injector before performing `operation`. Returns a promise that resolves when
   * the call may proceed, or rejects with the injected failure.
   */
  async before(operation: string): Promise<void> {
    this.#calls.set(operation, this.callCount(operation) + 1);
    const queue = this.#faults.get(operation);
    const fault = queue?.[0];
    if (fault === undefined) return;

    fault.remaining -= 1;
    if (fault.remaining <= 0) queue?.shift();

    switch (fault.kind) {
      case 'hang':
        return new Promise<void>(() => {
          /* deliberately never settles */
        });
      case 'delay':
        this.#advance?.(fault.delayMs ?? 0);
        return;
      case 'timeout':
      case 'error':
        throw new ContractError(
          makeError(fault.code ?? 'INTERNAL', {
            diagnostic_ref: `testkit:fault:${operation}`,
            occurred_at: this.#clock.nowIso(),
          }),
        );
    }
  }

  #push(operation: string, fault: Fault): this {
    const queue = this.#faults.get(operation) ?? [];
    queue.push(fault);
    this.#faults.set(operation, queue);
    return this;
  }
}

/**
 * Wrap every method of `target` so it consults `injector` first.
 *
 * Operation names are `${name}.${method}`, so a test says `failNext('policy.evaluate', ...)`
 * and reads like the thing it is describing.
 */
export function withFaults<T extends object>(name: string, target: T, injector: FaultInjector): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      if (typeof value !== 'function' || typeof property === 'symbol') return value;
      const operation = `${name}.${String(property)}`;
      return async (...args: unknown[]): Promise<unknown> => {
        await injector.before(operation);
        return (value as (...a: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}
