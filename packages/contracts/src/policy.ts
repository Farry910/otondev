import { z } from 'zod';
import { envelopeExtend } from './envelope.js';
import {
  AgentId,
  ApprovalId,
  DecisionRequestId,
  PlanId,
  PolicyDecisionId,
  ResourceRef,
  Sha256Digest,
  UserId,
  WorkflowId,
  WorkloadId,
} from './ids.js';
import {
  AutonomyLevel,
  BoundedText,
  DataClassSet,
  Environment,
  Rfc3339Utc,
  Signature,
} from './primitives.js';
import { ActionClass } from './plan.js';

/**
 * Policy decision and approval, contracts §5.
 *
 *   "Free-form 'yes', an emoji, a ticket label, model output, or chat text is not an approval
 *    unless a tenant policy adapter authenticates it and creates this exact bound record."
 *
 * That sentence is the whole schema's reason for existing. An approval is not a signal that
 * a human felt positive; it is a record bound to a specific actor, action, parameter digest,
 * resource, environment, expiry and use count. Every one of those bindings is a required
 * field here, so an adapter that wants to fabricate an approval from a thumbs-up has to
 * fabricate all of them explicitly and be seen doing it.
 */

export const POLICY_DECISIONS = ['allow', 'deny', 'require_approval'] as const;
export const PolicyDecisionOutcome = z.enum(POLICY_DECISIONS);
export type PolicyDecisionOutcome = z.infer<typeof PolicyDecisionOutcome>;

export const PolicySubject = z.object({
  agent_id: AgentId,
  workload_id: WorkloadId,
});

/** `engineering-pilot-v2@sha256:...` — the bundle a decision is reproducible against. */
export const PolicyBundleRef = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*@sha256:[0-9a-f]{64}$/, 'expected `<bundle-name>@sha256:<digest>`');

export const PolicyDecision = envelopeExtend({
  schema: z.literal('agentdev.policy_decision.v2'),
  id: PolicyDecisionId,
  subject: PolicySubject,
  action: ActionClass,
  resource: ResourceRef,
  environment: Environment,
  /** Normalised parameters. Editing any bound field invalidates the decision. */
  parameter_digest: Sha256Digest,
  workflow_id: WorkflowId,
  plan_id: PlanId,
  /** The *effective* level: the minimum across every contributing dimension. */
  autonomy_level: AutonomyLevel,
  data_classes: DataClassSet,
  decision: PolicyDecisionOutcome,
  policy_bundle: PolicyBundleRef,
  constraints: z.record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean()])),
  expires_at: Rfc3339Utc,
  /** Stable, enumerable codes — never prose. Reproducibility depends on it. */
  reason_codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64)).min(1).max(16),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const AUTHN_STRENGTHS = ['none', 'password', 'sso', 'mfa', 'hardware_key'] as const;

/**
 * The record a human approval must produce. Every field below is part of the binding; the
 * S4 exit criterion "editing any bound field invalidates an approval" is checked against
 * exactly this list.
 */
export const Approval = envelopeExtend({
  schema: z.literal('agentdev.approval.v2'),
  id: ApprovalId,
  approver: z.object({
    human_id: UserId,
    authn_strength: z.enum(AUTHN_STRENGTHS),
  }),
  decision_request_id: DecisionRequestId,
  action: ActionClass,
  resource: ResourceRef,
  environment: Environment,
  parameter_digest: Sha256Digest,
  plan_digest: Sha256Digest,
  expires_at: Rfc3339Utc,
  max_uses: z.number().int().positive(),
  uses: z.number().int().nonnegative(),
  status: z.enum(['active', 'consumed', 'expired', 'revoked']),
  signature: Signature,
});
export type Approval = z.infer<typeof Approval>;

/** The fields an approval is bound to. Changing any of them must invalidate it. */
export const APPROVAL_BOUND_FIELDS = [
  'action',
  'resource',
  'environment',
  'parameter_digest',
  'plan_digest',
] as const;

/**
 * What the Agent Core sends a human when policy says `require_approval`.
 *
 * It carries the digests rather than the prose so the thing approved is the thing executed:
 * an approval UI that renders a summary and binds to the summary has approved the summary.
 */
export const DecisionRequest = envelopeExtend({
  schema: z.literal('agentdev.decision_request.v2'),
  id: DecisionRequestId,
  workflow_id: WorkflowId,
  plan_id: PlanId,
  action: ActionClass,
  resource: ResourceRef,
  environment: Environment,
  parameter_digest: Sha256Digest,
  plan_digest: Sha256Digest,
  /** Human-readable, and explicitly not what is being bound. */
  summary: BoundedText(2000),
  /** What breaks if this is wrong. Required: an approval request without it is a rubber stamp. */
  blast_radius: BoundedText(1000),
  requested_autonomy: AutonomyLevel,
  data_classes: DataClassSet,
  expires_at: Rfc3339Utc,
  minimum_authn_strength: z.enum(AUTHN_STRENGTHS),
});
export type DecisionRequest = z.infer<typeof DecisionRequest>;
