import { z } from 'zod';
import { envelopeExtend } from './envelope.js';
import {
  ActionId,
  ApprovalId,
  CapabilityId,
  PolicyDecisionId,
  ResourceRef,
  Sha256Digest,
  WorkflowId,
} from './ids.js';
import { BoundedText, Rfc3339Utc } from './primitives.js';
import { ActionClass } from './plan.js';
import { ErrorCode } from './errors.js';

/**
 * External action and idempotency, contracts §7.
 *
 *   "An ambiguous timeout sets `outcome_unknown`; automatic retry is forbidden until
 *    reconciliation says absent or the provider guarantees the same idempotency key."
 *
 * `outcome_unknown` is the state that makes this contract worth having. The tempting design
 * has four states and treats a timeout as a failure, which is how one ticket gets three
 * comments and one branch gets two pull requests. Naming the unknown explicitly means the
 * retry decision has to be made by something that can go and look.
 */

export const ACTION_STATES = ['prepared', 'sent', 'succeeded', 'failed', 'outcome_unknown'] as const;
export const ActionState = z.enum(ACTION_STATES);
export type ActionState = z.infer<typeof ActionState>;

/** States from which an automatic retry is permitted. `outcome_unknown` is not one of them. */
export const AUTO_RETRYABLE_STATES = ['prepared', 'failed'] as const;

export function mayAutoRetry(state: ActionState): boolean {
  return (AUTO_RETRYABLE_STATES as readonly string[]).includes(state);
}

export const ADAPTERS = ['github', 'jira', 'slack', 'ci', 'deploy'] as const;
export const Adapter = z.enum(ADAPTERS);
export type Adapter = z.infer<typeof Adapter>;

export const ExternalAction = envelopeExtend({
  schema: z.literal('agentdev.action.v2'),
  id: ActionId,
  workflow_id: WorkflowId,
  adapter: Adapter,
  /** The adapter's own operation name, e.g. `pull_request.create_draft`. */
  operation: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).max(128),
  action_class: ActionClass,
  resource: ResourceRef,
  parameter_digest: Sha256Digest,
  /** `<tenant>:<action id>` — stable across retries of the same intent. */
  idempotency_key: z.string().min(3).max(256),
  state: ActionState,
  attempts: z.number().int().nonnegative(),
  policy_decision_id: PolicyDecisionId,
  approval_id: ApprovalId.nullable(),
  capability_id: CapabilityId,
  /** What the provider called it, once we know. Null until then. */
  remote_ref: BoundedText(256).nullable(),
  /** A code, never the provider's response body (contracts §11). */
  last_error: ErrorCode.nullable(),
  updated_at: Rfc3339Utc,
});
export type ExternalAction = z.infer<typeof ExternalAction>;

/**
 * What `lookup`/`reconcile` answers: did the effect happen?
 *
 * `indeterminate` is a legitimate answer and must stay distinguishable from `absent`. An
 * adapter that cannot tell the difference reports `indeterminate` and the action stays in
 * `outcome_unknown` — which blocks the workflow, correctly, rather than duplicating work.
 */
export const ReconcileResult = z.object({
  action_id: ActionId,
  outcome: z.enum(['present', 'absent', 'indeterminate']),
  remote_ref: BoundedText(256).nullable(),
  checked_at: Rfc3339Utc,
});
export type ReconcileResult = z.infer<typeof ReconcileResult>;

/**
 * How an action class can be undone. Chosen per class, not per call, so the answer is known
 * at planning time rather than discovered during an incident.
 */
export const COMPENSATION_KINDS = [
  'none', // nothing to undo (a read)
  'reverse', // an inverse operation exists (close the PR we opened)
  'annotate', // cannot be undone, but can be marked (a posted comment)
  'manual', // needs a human
] as const;
export const CompensationKind = z.enum(COMPENSATION_KINDS);
export type CompensationKind = z.infer<typeof CompensationKind>;

/**
 * The compensation available for each action class. Anything that publishes to a human is
 * `annotate` at best: a deleted Slack message was still read, and pretending otherwise is
 * how a compensation plan becomes fiction.
 */
export const COMPENSATION_BY_ACTION_CLASS: Readonly<Record<string, CompensationKind>> = {
  'worker.command': 'none',
  'worker.file_write': 'reverse',
  'git.create_branch': 'reverse',
  'git.commit': 'reverse',
  'git.push': 'manual',
  'git.open_draft_pr': 'reverse',
  'git.open_pr': 'reverse',
  'jira.comment': 'annotate',
  'jira.transition': 'reverse',
  'slack.post': 'annotate',
  'staging.deploy': 'manual',
  'cognition.generate': 'none',
  'memory.write': 'reverse',
  'presence.speak': 'annotate',
};
