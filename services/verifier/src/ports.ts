/**
 * The ports the verifier drives: a check runner, and the diff / secret / licence scanners.
 *
 * They are interfaces rather than implementations for the reason the whole package exists.
 * The verifier is "a separate process, independent of the executor, holding no publish
 * capability" (implementation-plan §5 S12) — so what it can do is exactly the union of the
 * ports handed to it at construction. A verifier that spawned processes or opened sockets on
 * its own would have authority nobody granted it, and no test could prove otherwise.
 *
 * Every port can report **unavailable**. That is not defensive padding: the S12 exit criteria
 * turn on it. "Explicit recording of skipped and unavailable checks" and "'skipped' is never
 * reported as pass" are only meaningful if a port has a way to say "I could not run" that is
 * distinct from "I ran and found nothing".
 */

import type { CheckStatus } from '@otondev/contracts';
import type { ForbiddenRule, ManifestCheck } from './manifest.js';

/**
 * What the checks run against.
 *
 * The commit and the diff, by digest — never a branch name or a working directory. The S12
 * exit criterion is "check execution against the **immutable** diff and commit", and a
 * mutable reference is how a verifier ends up certifying code that is no longer there.
 */
export interface VerificationTarget {
  workflow_id: string;
  head_sha: string;
  diff_digest: string;
  goal_digest: string;
  definition_of_done_ref: string;
}

export interface CheckOutcome {
  name: string;
  status: CheckStatus;
  /** Null when the check did not run. Faking a zero here is how "skipped" becomes "pass". */
  exit_code: number | null;
  /** Required by the evidence schema whenever the status is `skipped` or `unavailable`. */
  reason: string | null;
  log_ref: string | null;
  /**
   * The commit and diff the runner *actually* observed.
   *
   * Reported back rather than assumed so the verifier can detect that the target moved under
   * it. A runner that silently checked out something newer produces a green verdict about a
   * commit nobody reviewed, and without this field there is no way to notice.
   */
  observed_head_sha: string;
  observed_diff_digest: string;
}

export interface CheckRunner {
  /**
   * Run one manifest check against the immutable target.
   *
   * Implementations must not throw for an ordinary check failure — a failing test suite is a
   * `fail` outcome, not an exception. Throwing is reserved for the runner itself being
   * broken, and the verifier converts that into `unavailable`, never into `pass`.
   */
  run(check: ManifestCheck, target: VerificationTarget): Promise<CheckOutcome>;
}

export type ScannerKind = 'diff' | 'secret' | 'licence';

export interface ScanFinding {
  /** Which manifest `forbidden` rule this finding violates. */
  rule: ForbiddenRule;
  detail: string;
}

export interface ScanResult {
  kind: ScannerKind;
  status: 'clean' | 'findings' | 'unavailable';
  findings: readonly ScanFinding[];
  /** Why, when the scanner could not run. */
  reason: string | null;
}

/**
 * The diff, secret and licence scanning hooks (S12 exit criterion).
 *
 * A hook, not a built-in: which secret scanner a deployment trusts is a deployment decision,
 * and baking one in would make the choice unreviewable. What this package fixes is the
 * *contract* — that a scanner which cannot run says so, and that saying so cannot produce a
 * passing verdict.
 */
export interface Scanner {
  readonly kind: ScannerKind;
  scan(target: VerificationTarget): Promise<ScanResult>;
}

/** The executor's own claim about its work. Advisory input, never authority — see `verdict.ts`. */
export type ExecutorClaim = 'pass' | 'fail' | 'unknown';
