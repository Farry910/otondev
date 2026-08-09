import { z } from 'zod';
import { envelopeExtend } from './envelope.js';
import {
  AgentId,
  AnyRef,
  ArtifactId,
  CheckpointId,
  DefinitionOfDoneRef,
  ResourceRef,
  WorkflowId,
  WorkloadId,
} from './ids.js';
import { AutonomyLevel, DataClassSet, Rfc3339Utc, RiskLevel } from './primitives.js';
import { WorkflowState } from './workflow-states.js';

export * from './workflow-states.js';

/**
 * Workflow record, contracts §3.
 *
 *   "Every transition is compare-and-set on `state_version` and records a transition event."
 *
 * `lease` is the concurrency primitive for the whole platform. Owner and expiry alone are
 * not enough — an owner whose lease expired mid-write must have that write rejected after
 * the fact, which is what `fencing_token` is for. The token is monotonic per workflow and is
 * quoted in every capability the broker mints, so a fenced worker loses its ability to act
 * externally at the same instant it loses its lease.
 */

export const WORKFLOW_TYPES = [
  'ticket_delivery',
  'review',
  'incident_response',
  'meeting_presence',
  'maintenance',
] as const;

export const WorkflowLease = z.object({
  owner: WorkloadId,
  expires_at: Rfc3339Utc,
  /** Monotonic per workflow. A write quoting an older token is rejected. */
  fencing_token: z.number().int().nonnegative(),
});
export type WorkflowLease = z.infer<typeof WorkflowLease>;

export const WorkflowBudget = z.object({
  usd_max: z.number().nonnegative(),
  deadline: Rfc3339Utc,
  cpu_seconds: z.number().int().nonnegative(),
});
export type WorkflowBudget = z.infer<typeof WorkflowBudget>;

export const WorkflowRecord = envelopeExtend({
  schema: z.literal('agentdev.workflow.v2'),
  id: WorkflowId,
  agent_id: AgentId,
  type: z.enum(WORKFLOW_TYPES),
  state: WorkflowState,
  /** Compare-and-set target. Every transition increments it exactly once. */
  state_version: z.number().int().nonnegative(),
  goal_ref: ArtifactId,
  source_refs: z.array(AnyRef).min(1),
  definition_of_done_ref: DefinitionOfDoneRef,
  risk: RiskLevel,
  data_classes: DataClassSet,
  autonomy_required: AutonomyLevel,
  priority: z.number().int().min(0).max(100),
  budget: WorkflowBudget,
  lease: WorkflowLease.nullable(),
  /** Named resources this workflow holds, for the arbitration table in agent-core. */
  locks: z.array(ResourceRef),
  attempt: z.number().int().positive(),
  next_wakeup_at: Rfc3339Utc.nullable(),
  last_checkpoint_ref: CheckpointId.nullable(),
});
export type WorkflowRecord = z.infer<typeof WorkflowRecord>;

/**
 * The transition event contracts §3 requires on every change.
 *
 * Recorded whether the transition succeeded or was refused: a rejected transition is
 * evidence too, and "why did nothing happen" is the question incident review actually asks.
 */
export const WorkflowTransition = envelopeExtend({
  schema: z.literal('agentdev.transition.v2'),
  workflow_id: WorkflowId,
  from_state: WorkflowState,
  to_state: WorkflowState,
  /** The `state_version` this transition moved the record *to*. */
  state_version: z.number().int().nonnegative(),
  channel: z.enum(['normal', 'operator', 'recovery']),
  accepted: z.boolean(),
  reason_codes: z.array(z.string().max(64)).max(16),
  /** The lease that authorised it, if any — absent for an operator command. */
  fencing_token: z.number().int().nonnegative().nullable(),
  occurred_at: Rfc3339Utc,
});
export type WorkflowTransition = z.infer<typeof WorkflowTransition>;
