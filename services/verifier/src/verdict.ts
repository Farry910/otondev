/**
 * Turning a list of check outcomes into a verdict, and keeping it there.
 *
 * Split out from the service because these are the rules the S12 exit criteria are written
 * about, and rules that live in a class method alongside I/O get tested through the I/O.
 * Here they are total functions over data, so the test that "'skipped' is never reported as
 * pass" is a test of the rule rather than of one path through the service.
 */

import type { CheckStatus } from '@otondev/contracts';
import type { VerifierVerdict } from '@otondev/sdk';
import type { CheckOutcome, ExecutorClaim } from './ports.js';

export type Verdict = VerifierVerdict['verdict'];

/**
 * Methods a verifier must never expose.
 *
 * `VerifierClient` already has none of them, so this is belt-and-braces — but the exit
 * criterion is "the verifier **cannot** publish, approve, or review its own executor's
 * narrative", and a type constraint is erased at runtime. This list is what
 * {@link assertNoPublishSurface} walks, so a future subclass that grows a `publish` method
 * fails a test rather than a review.
 */
export const FORBIDDEN_VERIFIER_METHODS: readonly string[] = [
  'publish',
  'comment',
  'approve',
  'transition',
  'merge',
  'review',
  'submitReview',
  'requestChanges',
];

/**
 * Only `pass` is a pass.
 *
 * `@otondev/contracts` states the same rule over a single {@link CheckStatus}. This is the
 * aggregate form, and it is stated positively — every check passed — rather than as "nothing
 * failed", because "nothing failed" is true of an empty list and of a list of skips.
 */
export function aggregateVerdict(checks: readonly CheckOutcome[]): Verdict {
  if (checks.length === 0) {
    // No checks is not a clean bill of health. It is the absence of one.
    return 'inconclusive';
  }
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'skipped' || check.status === 'unavailable')) {
    // "Best effort" is not equivalent to pass (task-engine.md, definition of done). A run
    // that skipped a check did not establish what that check establishes, so the strongest
    // honest answer is inconclusive — and the delivery gate refuses an inconclusive bundle.
    return 'inconclusive';
  }
  return 'pass';
}

/**
 * What the run could not establish, in the order the checks were declared.
 *
 * `limitations` on the evidence bundle is "present and possibly empty, never absent", and an
 * empty array is therefore a positive claim: *nothing* was left unestablished. It has to be
 * earned, so it is derived from the outcomes rather than passed in.
 */
export function limitationsFrom(checks: readonly CheckOutcome[]): string[] {
  return checks
    .filter((check) => check.status === 'skipped' || check.status === 'unavailable')
    .map((check) => `${check.name} (${check.status}): ${check.reason ?? 'no reason recorded'}`);
}

/** The `checks` projection the SDK verdict carries. Narrower than {@link CheckOutcome}. */
export function summarise(checks: readonly CheckOutcome[]): VerifierVerdict['checks'] {
  return checks.map((check) => ({ name: check.name, status: check.status, reason: check.reason }));
}

/**
 * Reconcile the verifier's own verdict with what the executor claimed.
 *
 * The S12 exit criterion — "executor says pass while verifier fails resolves as **fail**" —
 * is really a statement about direction. This function can move a verdict *down* and never
 * up, so there is no argument the executor can supply that turns a fail into a pass.
 *
 * The disagreement is recorded as a limitation rather than dropped. Two components
 * disagreeing about whether the work is done is a fact about the run that whoever reads the
 * evidence needs, and it is the single most useful signal that an executor is misreporting.
 */
export function reconcileWithExecutorClaim(verdict: VerifierVerdict, claim: ExecutorClaim): VerifierVerdict {
  const limitations = [...verdict.limitations];

  if (claim === 'pass' && verdict.verdict !== 'pass') {
    limitations.push(
      `executor claimed pass; the verifier observed ${verdict.verdict}. The verifier's verdict stands.`,
    );
    return { ...verdict, limitations };
  }

  if (claim === 'fail' && verdict.verdict === 'pass') {
    // The executor knows things the verifier cannot see — a step it abandoned, a budget it
    // exhausted. Downgrading is always safe; the reverse never is.
    limitations.push('executor reported fail while every verifier check passed; downgraded to inconclusive.');
    return { ...verdict, verdict: 'inconclusive', limitations };
  }

  if (claim === 'unknown' && verdict.verdict === 'pass') {
    limitations.push('executor outcome unknown; the verifier could not confirm the run completed.');
    return { ...verdict, verdict: 'inconclusive', limitations };
  }

  return { ...verdict, limitations };
}

/**
 * Prove, at runtime, that a candidate verifier holds no publish capability.
 *
 * Walks the prototype chain rather than checking own properties: the interesting way this
 * criterion breaks is a subclass adding `publish()` to its prototype, which `Object.keys`
 * would not see.
 */
export function assertNoPublishSurface(candidate: object): void {
  const found: string[] = [];
  for (const method of FORBIDDEN_VERIFIER_METHODS) {
    if (method in (candidate as Record<string, unknown>)) found.push(method);
  }
  if (found.length > 0) {
    throw new Error(
      `the verifier must hold no publish capability, but exposes: ${found.join(', ')}. ` +
        'S12: "the verifier cannot publish, approve, or review its own executor\'s narrative".',
    );
  }
}

/**
 * Strip everything that is not one of the seven fields the verifier is allowed to see.
 *
 * The exit criterion is that the verifier "receives goal, diff, definition of done, and
 * evidence — **never** the executor's narrative". `VerifyInput` has no field prose could
 * occupy, but types are erased: at runtime an extra `narrative` property rides along on the
 * same object and any code doing `{...input}` would carry it into the verdict.
 *
 * Projecting makes the guarantee structural rather than a matter of care. Whatever else is on
 * the wire cannot reach a decision, because it does not survive the front door.
 */
export function projectVerifyInput<T extends Record<string, unknown>>(input: T): {
  workflow_id: string;
  goal_digest: string;
  diff_digest: string;
  head_sha: string;
  definition_of_done_ref: string;
  manifest_version: string;
  evidence_refs: readonly string[];
} {
  return {
    workflow_id: String(input['workflow_id'] ?? ''),
    goal_digest: String(input['goal_digest'] ?? ''),
    diff_digest: String(input['diff_digest'] ?? ''),
    head_sha: String(input['head_sha'] ?? ''),
    definition_of_done_ref: String(input['definition_of_done_ref'] ?? ''),
    manifest_version: String(input['manifest_version'] ?? ''),
    evidence_refs: Array.isArray(input['evidence_refs']) ? [...(input['evidence_refs'] as string[])] : [],
  };
}

/** A check outcome for something that could not run. Never `pass`, always with a reason. */
export function unavailable(name: string, reason: string, target: { head_sha: string; diff_digest: string }): CheckOutcome {
  return {
    name,
    status: 'unavailable' satisfies CheckStatus,
    exit_code: null,
    reason,
    log_ref: null,
    observed_head_sha: target.head_sha,
    observed_diff_digest: target.diff_digest,
  };
}
