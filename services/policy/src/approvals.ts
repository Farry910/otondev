import { APPROVAL_BOUND_FIELDS } from '@otondev/contracts';
import type { Approval } from '@otondev/contracts';
import type { ApprovalBinding } from '@otondev/sdk';
import type { ActionRule } from './bundle.js';
import type { ReasonCode } from './reasons.js';

/**
 * Approval binding and lifecycle.
 *
 * Contracts §5, and the sentence the whole module exists to enforce:
 *
 *   "Free-form 'yes,' an emoji, a ticket label, model output, or chat text is not an approval
 *    unless a tenant policy adapter authenticates it and creates this exact bound record."
 *
 * Two design choices carry that.
 *
 * **There is no string-parsing path into this module.** Nothing here accepts prose and
 * decides whether it meant yes. The only way to create an approval is to supply an
 * authenticated approver and a complete binding, every field of which is required. An
 * adapter that wants to turn a thumbs-up into an approval has to fabricate all of it
 * explicitly, in code someone reviews, rather than by loosening a regex.
 *
 * **The bound-field check iterates the contract's own list.** `APPROVAL_BOUND_FIELDS` lives in
 * `@otondev/contracts`; if a field is added there and not handled here, the exhaustiveness
 * test fails. Spot-checking two or three fields by hand is how the fourth stops being bound.
 */

export type BindingCheck = { ok: true } | { ok: false; reason: ReasonCode; field?: string };

/**
 * Does `approval` authorise exactly `binding`?
 *
 * Every field in `APPROVAL_BOUND_FIELDS` must match. Not "the important ones" — the S4 exit
 * criterion is that editing *any* bound field invalidates, and the only way to keep that true
 * as the contract grows is to drive the comparison from the contract.
 */
export function checkBinding(approval: Approval, binding: ApprovalBinding): BindingCheck {
  for (const field of APPROVAL_BOUND_FIELDS) {
    if (approval[field] !== binding[field]) {
      return { ok: false, reason: 'APPROVAL_BINDING_MISMATCH', field };
    }
  }
  return { ok: true };
}

export interface LifecycleInput {
  approval: Approval;
  binding: ApprovalBinding;
  /** RFC3339 UTC. Passed in so the check is a pure function of its inputs. */
  now: string;
  /** When the action rule demands a stronger approver than the record carries. */
  requiredAuthnStrength?: ActionRule['minimum_authn_strength'];
}

/**
 * Everything that must hold before an approval may be consumed.
 *
 * Ordered so the most specific answer wins: a caller debugging a refusal is better served by
 * "you edited the resource" than by "expired", when both happen to be true.
 */
export function checkConsumable(input: LifecycleInput): BindingCheck {
  const { approval, binding, now, requiredAuthnStrength } = input;

  const bound = checkBinding(approval, binding);
  if (!bound.ok) return bound;

  if (approval.status === 'revoked') return { ok: false, reason: 'APPROVAL_REVOKED' };
  if (approval.status === 'consumed' || approval.uses >= approval.max_uses) {
    return { ok: false, reason: 'APPROVAL_CONSUMED' };
  }
  // Expiry is compared as an instant, not as a string: '2026-07-30T09:00:00Z' and
  // '2026-07-30T09:00:00.000Z' are the same moment and must behave identically.
  if (Date.parse(approval.expires_at) <= Date.parse(now)) {
    return { ok: false, reason: 'APPROVAL_EXPIRED' };
  }
  if (approval.status === 'expired') return { ok: false, reason: 'APPROVAL_EXPIRED' };

  if (requiredAuthnStrength !== undefined && !meetsAuthnStrength(approval.approver.authn_strength, requiredAuthnStrength)) {
    return { ok: false, reason: 'APPROVAL_AUTHN_TOO_WEAK' };
  }

  return { ok: true };
}

/**
 * Authentication strength ordering.
 *
 * `signed_command` sits alongside `hardware_key` rather than above `mfa` by seniority: it is
 * an out-of-band administrative path (implementation-plan §5 S18) and is accepted wherever
 * `mfa` is, but a rule that demands `hardware_key` is not satisfied by `mfa`.
 */
const AUTHN_RANK: Record<string, number> = {
  none: 0,
  password: 1,
  sso: 2,
  mfa: 3,
  signed_command: 3,
  hardware_key: 4,
};

export function meetsAuthnStrength(actual: string, required: string): boolean {
  return (AUTHN_RANK[actual] ?? -1) >= (AUTHN_RANK[required] ?? Number.POSITIVE_INFINITY);
}

/**
 * The record after a successful consumption.
 *
 * Returned rather than mutated so the caller decides when it becomes durable — the store
 * writes it under a compare-and-set, and a function that had already mutated the object
 * would make a failed write silently disagree with memory.
 */
export function consumed(approval: Approval): Approval {
  const uses = approval.uses + 1;
  return { ...approval, uses, status: uses >= approval.max_uses ? 'consumed' : 'active' };
}

/** Mark expiry without consuming a use. Lets a sweep record the transition honestly. */
export function expired(approval: Approval): Approval {
  return { ...approval, status: 'expired' };
}
