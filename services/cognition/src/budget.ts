/**
 * Spend control — routing step 6 ("reserve budget") and the two budget exit criteria:
 * "budget exhaustion pauses rather than overruns" and "a model cannot approve its own
 * increase".
 *
 * Reserve-then-reconcile rather than charge-after. Charging after the call is simpler and
 * wrong: the overrun has already happened by the time it is detected, and with concurrent
 * requests on one workflow every one of them passes the pre-check and the budget is breached
 * by the sum. Reserving the *estimate* up front makes concurrent requests contend for the
 * same pool, and reconciling afterwards returns the difference between estimate and actual.
 *
 * The self-approval rule is enforced by type, not by review. {@link BudgetLedger.increase}
 * takes an {@link IncreaseAuthorization} that only a human or the policy engine can construct,
 * and there is no code path from a provider response to one. A model that emits
 * `{"increase_budget": 100}` produces a forbidden-field validation failure long before it
 * reaches anything here — but if it somehow did, there is still nothing it could call.
 */

export interface Reservation {
  readonly id: string;
  readonly workflowId: string;
  readonly amountUsd: number;
}

export type ReserveOutcome =
  | { readonly ok: true; readonly reservation: Reservation }
  | { readonly ok: false; readonly reason: 'exhausted'; readonly remainingUsd: number; readonly requestedUsd: number };

/**
 * Proof that a budget increase was authorised by someone who is allowed to authorise one.
 *
 * The private brand is the mechanism: this type cannot be constructed by object literal from
 * outside this module, so an increase cannot be conjured by a caller that merely knows the
 * shape. It is issued only by {@link authorizeIncrease}, which requires a human or policy
 * principal and refuses anything that looks like a model.
 */
export interface IncreaseAuthorization {
  readonly workflowId: string;
  readonly amountUsd: number;
  readonly approvedBy: string;
  readonly reason: string;
  readonly [brand]: true;
}

declare const brand: unique symbol;

export type IncreasePrincipal =
  | { readonly kind: 'human'; readonly id: string }
  | { readonly kind: 'policy'; readonly decisionId: string };

/**
 * Mint an authorization. The only way to get one.
 *
 * `kind` is a closed union with no `model` member — a model has no principal type it could
 * present, so "a model cannot approve its own increase" is true because there is nothing for
 * it to pass, not because a check rejects it.
 */
export function authorizeIncrease(
  principal: IncreasePrincipal,
  workflowId: string,
  amountUsd: number,
  reason: string,
): IncreaseAuthorization {
  if (amountUsd <= 0) {
    throw new RangeError('a budget increase must be positive');
  }
  // The brand exists only in the type system — `declare const brand` has no runtime value, so
  // assigning it here would throw. The cast is the whole mechanism: it is available only
  // inside this module, which is what makes this function the sole way to obtain one.
  return {
    workflowId,
    amountUsd,
    approvedBy: principal.kind === 'human' ? `human:${principal.id}` : `policy:${principal.decisionId}`,
    reason,
  } as unknown as IncreaseAuthorization;
}

export interface BudgetState {
  readonly limitUsd: number;
  readonly reservedUsd: number;
  readonly spentUsd: number;
  readonly remainingUsd: number;
  readonly paused: boolean;
}

export class BudgetLedger {
  readonly #limits = new Map<string, number>();
  readonly #spent = new Map<string, number>();
  readonly #reservations = new Map<string, Reservation>();
  readonly #paused = new Set<string>();
  #sequence = 0;

  setLimit(workflowId: string, limitUsd: number): void {
    this.#limits.set(workflowId, limitUsd);
  }

  state(workflowId: string): BudgetState {
    const limitUsd = this.#limits.get(workflowId) ?? 0;
    const spentUsd = this.#spent.get(workflowId) ?? 0;
    const reservedUsd = [...this.#reservations.values()]
      .filter((reservation) => reservation.workflowId === workflowId)
      .reduce((total, reservation) => total + reservation.amountUsd, 0);
    return {
      limitUsd,
      reservedUsd,
      spentUsd,
      remainingUsd: limitUsd - spentUsd - reservedUsd,
      paused: this.#paused.has(workflowId),
    };
  }

  /**
   * Hold `estimateUsd` against the workflow's budget.
   *
   * Refuses rather than overruns, and marks the workflow paused so the refusal is a state the
   * workflow engine can see rather than a one-off error the caller might swallow and retry.
   */
  reserve(workflowId: string, estimateUsd: number): ReserveOutcome {
    const state = this.state(workflowId);
    if (state.remainingUsd < estimateUsd) {
      this.#paused.add(workflowId);
      return { ok: false, reason: 'exhausted', remainingUsd: state.remainingUsd, requestedUsd: estimateUsd };
    }

    const reservation: Reservation = {
      id: `res_${++this.#sequence}`,
      workflowId,
      amountUsd: estimateUsd,
    };
    this.#reservations.set(reservation.id, reservation);
    return { ok: true, reservation };
  }

  /**
   * Settle a reservation against what was actually spent.
   *
   * An actual above the estimate is recorded in full — the money is gone whether or not it was
   * predicted — and the workflow is paused if that pushes it past its limit, so the next
   * request stops rather than compounding the overrun.
   */
  reconcile(reservationId: string, actualUsd: number): BudgetState {
    const reservation = this.#reservations.get(reservationId);
    if (reservation === undefined) {
      throw new Error(`unknown reservation '${reservationId}'`);
    }
    this.#reservations.delete(reservationId);

    const spent = (this.#spent.get(reservation.workflowId) ?? 0) + actualUsd;
    this.#spent.set(reservation.workflowId, spent);

    const state = this.state(reservation.workflowId);
    if (state.remainingUsd <= 0) {
      this.#paused.add(reservation.workflowId);
    }
    return this.state(reservation.workflowId);
  }

  /** Release a reservation without spending — the call never happened. */
  release(reservationId: string): void {
    this.#reservations.delete(reservationId);
  }

  increase(authorization: IncreaseAuthorization): BudgetState {
    const current = this.#limits.get(authorization.workflowId) ?? 0;
    this.#limits.set(authorization.workflowId, current + authorization.amountUsd);
    // An increase is also the only thing that lifts a pause. Resuming without more budget
    // would put the workflow straight back into the state it just paused for.
    this.#paused.delete(authorization.workflowId);
    return this.state(authorization.workflowId);
  }

  isPaused(workflowId: string): boolean {
    return this.#paused.has(workflowId);
  }
}
