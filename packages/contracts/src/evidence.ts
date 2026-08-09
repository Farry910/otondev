import { z } from 'zod';
import { envelopeExtend } from './envelope.js';
import {
  ActionId,
  AnyRef,
  ApprovalId,
  ArtifactId,
  EvidenceBundleId,
  GitSha,
  PinnedVersionRef,
  PolicyDecisionId,
  Sha256Digest,
  WorkflowId,
} from './ids.js';
import { BoundedText, Rfc3339Utc, Signature } from './primitives.js';

/**
 * Evidence bundle, contracts §10.
 *
 *   "An evidence bundle is immutable; corrections create a superseding bundle."
 *
 * The delivery gate reads this record and nothing else. That is why `verifier.limitations`
 * and the per-check `status` are required rather than optional: a bundle whose checks are all
 * "skipped" must be *visibly* all-skipped. The S12 exit criterion "'skipped' is never
 * reported as pass" is unenforceable if the schema lets a skipped check look like an absent
 * one.
 */

export const CHECK_STATUSES = ['pass', 'fail', 'skipped', 'unavailable'] as const;
export const CheckStatus = z.enum(CHECK_STATUSES);
export type CheckStatus = z.infer<typeof CheckStatus>;

/** Only `pass` is a pass. Stated as code because it is the rule most likely to erode. */
export function isPassing(status: CheckStatus): boolean {
  return status === 'pass';
}

export const EvidenceCheck = z.object({
  name: z.string().min(1).max(64),
  command_digest: Sha256Digest,
  status: CheckStatus,
  /** Null when the check did not run — a skipped check has no exit code, and faking one lies. */
  exit_code: z.number().int().nullable(),
  log_ref: ArtifactId.nullable(),
  log_digest: Sha256Digest.nullable(),
  /** Why, when the status is `skipped` or `unavailable`. Required for those, by refinement. */
  reason: BoundedText(300).nullable(),
});
export type EvidenceCheck = z.infer<typeof EvidenceCheck>;

export const EvidenceArtifact = z.object({
  ref: ArtifactId,
  kind: z.enum(['junit', 'coverage', 'diff', 'log', 'screenshot', 'sbom', 'scan', 'other']),
  digest: Sha256Digest,
  retention: z.object({
    expires_at: Rfc3339Utc.nullable(),
    legal_hold: z.boolean(),
  }),
});
export type EvidenceArtifact = z.infer<typeof EvidenceArtifact>;

export const EvidenceBundle = envelopeExtend({
  schema: z.literal('agentdev.evidence.v2'),
  id: EvidenceBundleId,
  workflow_id: WorkflowId,
  task_source: AnyRef,
  repository: z.object({
    url: z.string().max(512),
    base_sha: GitSha,
    head_sha: GitSha,
    diff_digest: Sha256Digest,
  }),
  environment: z.object({
    /** Pinned by digest, not by tag. A tag is a promise; a digest is a fact. */
    worker_image: z.string().regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/),
    toolchain: z.array(BoundedText(128)).max(64),
  }),
  checks: z.array(EvidenceCheck).min(1).max(128),
  verifier: z.object({
    version: PinnedVersionRef,
    verdict: z.enum(['pass', 'fail', 'inconclusive']),
    /** What the verifier could not establish. Present and possibly empty, never absent. */
    limitations: z.array(BoundedText(300)).max(32),
  }),
  policy_refs: z.array(PolicyDecisionId).max(64),
  approval_refs: z.array(ApprovalId).max(16),
  action_refs: z.array(ActionId).max(64),
  artifacts: z.array(EvidenceArtifact).max(128),
  /** The bundle this one replaces. Corrections supersede; they never mutate. */
  supersedes: EvidenceBundleId.nullable(),
  signature: Signature,
}).refine(
  (bundle) =>
    bundle.checks.every(
      (check) =>
        (check.status !== 'skipped' && check.status !== 'unavailable') || check.reason !== null,
    ),
  { error: 'a skipped or unavailable check must record why', path: ['checks'] },
);
export type EvidenceBundle = z.infer<typeof EvidenceBundle>;

/**
 * The delivery gate, contracts §10 and the S9 exit criterion "the delivery gate rejects an
 * incomplete bundle".
 *
 * Complete means: the verifier says pass, and no check is silently missing. A verifier
 * verdict of `pass` alongside a failing check is not a contradiction to resolve — it is an
 * incomplete bundle, and it is refused.
 */
export function evidenceGateFailures(bundle: {
  checks: readonly { name: string; status: CheckStatus }[];
  verifier: { verdict: 'pass' | 'fail' | 'inconclusive' };
}): string[] {
  const failures: string[] = [];
  if (bundle.verifier.verdict !== 'pass') {
    failures.push(`verifier verdict is "${bundle.verifier.verdict}"`);
  }
  for (const check of bundle.checks) {
    if (check.status === 'fail') failures.push(`check "${check.name}" failed`);
    if (check.status === 'unavailable') failures.push(`check "${check.name}" was unavailable`);
  }
  if (bundle.checks.length === 0) failures.push('bundle contains no checks');
  return failures;
}
