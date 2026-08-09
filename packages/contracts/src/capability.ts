import { z } from 'zod';
import { envelopeExtend } from './envelope.js';
import {
  ActionId,
  AgentId,
  CapabilityId,
  ResourceRef,
  Sha256Digest,
  WorkflowId,
  WorkloadId,
} from './ids.js';
import { Rfc3339Utc, Signature } from './primitives.js';
import { ActionClass } from './plan.js';

/**
 * Capability, contracts §6.
 *
 *   "The capability is an authorization token/handle, not the target-system secret. The
 *    connector checks signature, expiry, use count, fencing token, revocation epoch,
 *    parameter digest, and target resource."
 *
 * Those seven checks are the S5 exit criterion, so they are enumerated here as
 * {@link CAPABILITY_CHECKS} rather than left for each connector to remember. A connector
 * that iterates the list cannot forget the sixth one.
 *
 * There is no field on this record that could hold a credential, and that is by
 * construction, not by convention: the broker never returns a secret value to a caller at
 * all, so there is nothing to put here.
 */

export const CapabilityConstraints = z.object({
  /** Digest of the normalised call parameters. A mismatch is a rejection, not a warning. */
  parameter_digest: Sha256Digest,
  max_uses: z.number().int().positive(),
  /** Optional narrowing, e.g. `{ branch_prefix: 'agent/' }`. */
  extra: z.record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean()])).optional(),
});
export type CapabilityConstraints = z.infer<typeof CapabilityConstraints>;

export const Capability = envelopeExtend({
  schema: z.literal('agentdev.capability.v2'),
  id: CapabilityId,
  subject: z.object({
    workload_id: WorkloadId,
    agent_id: AgentId,
  }),
  workflow_id: WorkflowId,
  action_id: ActionId,
  operation: ActionClass,
  resource: ResourceRef,
  constraints: CapabilityConstraints,
  /** Ties the capability to a live lease. A fenced worker's capabilities die with it. */
  lease_fencing_token: z.number().int().nonnegative(),
  issued_at: Rfc3339Utc,
  expires_at: Rfc3339Utc,
  /** Bumped globally to invalidate every outstanding capability at once. */
  revocation_epoch: z.number().int().nonnegative(),
  broker_signature: Signature,
});
export type Capability = z.infer<typeof Capability>;

/**
 * The verification matrix from contracts §6, in the order a connector should apply it:
 * cheapest and most conclusive first, so a revoked capability is rejected before anyone
 * spends time hashing parameters.
 */
export const CAPABILITY_CHECKS = [
  'signature',
  'expiry',
  'revocation_epoch',
  'fencing_token',
  'use_count',
  'parameter_digest',
  'resource',
] as const;
export type CapabilityCheck = (typeof CAPABILITY_CHECKS)[number];

/** Why a capability was refused. One reason per failed check, in matrix order. */
export const CapabilityVerdict = z.object({
  valid: z.boolean(),
  failed_checks: z.array(z.enum(CAPABILITY_CHECKS)),
  capability_id: CapabilityId,
  checked_at: Rfc3339Utc,
});
export type CapabilityVerdict = z.infer<typeof CapabilityVerdict>;

/**
 * What the caller asks the broker for. Note there is no "give me the credential" variant:
 * the broker retrieves secrets only for a trusted adapter, and the adapter is inside the
 * broker's process (implementation-plan §5 S5).
 */
export const CapabilityRequest = z.object({
  subject: z.object({ workload_id: WorkloadId, agent_id: AgentId }),
  workflow_id: WorkflowId,
  action_id: ActionId,
  operation: ActionClass,
  resource: ResourceRef,
  parameter_digest: Sha256Digest,
  max_uses: z.number().int().positive(),
  lease_fencing_token: z.number().int().nonnegative(),
  requested_ttl_seconds: z.number().int().positive().max(3600),
  policy_decision_id: z.string().min(1),
});
export type CapabilityRequest = z.infer<typeof CapabilityRequest>;
