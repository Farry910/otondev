import { z } from 'zod';
import { envelopeExtend } from './envelope.js';
import {
  CapabilityId,
  DefinitionOfDoneRef,
  GitSha,
  PlanId,
  PolicyDecisionId,
  ResourceRef,
  Sha256Digest,
  WorkflowId,
  WorkspaceId,
} from './ids.js';
import { BoundedText, Rfc3339Utc, RiskLevel } from './primitives.js';

/**
 * Plan and execution command, contracts §4.
 *
 *   "The worker rejects commands with a stale fencing token, expired capability, changed
 *    plan digest, or missing policy."
 *
 * All four rejection reasons are fields on the command rather than ambient state, so the
 * worker can refuse without consulting anything. A worker that has to call home to find out
 * whether it is still allowed to run is a worker that keeps running when the network is the
 * thing that broke.
 */

/**
 * What a step is allowed to do, coarsely. The class — not the model's description of the
 * step — is what policy evaluates and what the capability is bound to.
 */
export const ACTION_CLASSES = [
  'worker.command',
  'worker.file_write',
  'git.create_branch',
  'git.commit',
  'git.push',
  'git.open_draft_pr',
  'git.open_pr',
  'jira.comment',
  'jira.transition',
  'slack.post',
  'staging.deploy',
  'cognition.generate',
  'memory.write',
  'presence.speak',
] as const;
export const ActionClass = z.enum(ACTION_CLASSES);
export type ActionClass = z.infer<typeof ActionClass>;

export const PlanStep = z.object({
  step_id: z.string().regex(/^s[0-9]+$/).max(16),
  purpose: BoundedText(200),
  action_class: ActionClass,
  risk: RiskLevel,
  /** Checkable without asking the executor whether it thinks it succeeded. */
  success_condition: BoundedText(200),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const PlanLimits = z.object({
  files_changed: z.number().int().positive(),
  commands: z.number().int().positive(),
  wall_seconds: z.number().int().positive(),
});
export type PlanLimits = z.infer<typeof PlanLimits>;

export const Plan = envelopeExtend({
  schema: z.literal('agentdev.plan.v2'),
  id: PlanId,
  workflow_id: WorkflowId,
  /** Binds the plan to the goal it was built for; a changed goal invalidates the plan. */
  goal_digest: Sha256Digest,
  assumptions: z.array(BoundedText(300)).max(32),
  /** Stated unknowns. A plan with none, on a non-trivial task, is a plan that guessed. */
  unknowns: z.array(BoundedText(300)).max(32),
  expected_files: z.array(BoundedText(400)).max(256),
  expected_external_effects: z.array(ActionClass).max(64),
  steps: z.array(PlanStep).min(1).max(128),
  definition_of_done_ref: DefinitionOfDoneRef,
  rollback_or_compensation: z.object({
    before_publish: BoundedText(200),
    after_publish: BoundedText(200),
  }),
  limits: PlanLimits,
});
export type Plan = z.infer<typeof Plan>;

export const ResourceLimits = z.object({
  cpu_seconds: z.number().int().positive(),
  memory_mb: z.number().int().positive(),
  disk_mb: z.number().int().positive(),
  wall_seconds: z.number().int().positive(),
  usd_max: z.number().nonnegative(),
});
export type ResourceLimits = z.infer<typeof ResourceLimits>;

/**
 * The unit of work handed to a worker (contracts §4). Everything the worker needs to decide
 * whether it may proceed travels with it.
 */
export const ExecutionCommand = envelopeExtend({
  schema: z.literal('agentdev.execution_command.v2'),
  workflow_id: WorkflowId,
  plan_id: PlanId,
  step_id: z.string().regex(/^s[0-9]+$/).max(16),
  /** Stale token -> reject. The worker checks this before anything else. */
  fencing_token: z.number().int().nonnegative(),
  /** Missing policy -> reject. There is no "probably fine" path. */
  policy_decision_id: PolicyDecisionId,
  capability_ids: z.array(CapabilityId).max(16),
  workspace_id: WorkspaceId,
  /** Changed base -> return to planning rather than improvise (S11 exit criterion). */
  base_sha: GitSha,
  /** Changed plan digest -> reject. */
  plan_digest: Sha256Digest,
  repository: ResourceRef,
  timeout_at: Rfc3339Utc,
  limits: ResourceLimits,
  /** Opaque handle the executor watches; cancellation must not require a new connection. */
  cancellation_token: z.string().min(1).max(128),
  /** The schema the step's structured result must satisfy. */
  response_schema: z.string().min(1).max(128),
});
export type ExecutionCommand = z.infer<typeof ExecutionCommand>;
