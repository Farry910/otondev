import { z } from 'zod';
import { envelopeExtend } from './envelope.js';
import {
  AgentId,
  AnyRef,
  CognitionRequestId,
  ContextId,
  Sha256Digest,
  WorkflowId,
} from './ids.js';
import { BoundedText, DataClassSet, Rfc3339Utc, RiskLevel } from './primitives.js';

/**
 * Cognition request and result, contracts §8 and cognition-router.md "Request contract".
 *
 *   §8  "It never contains a trusted authorization decision."
 *   router "Raw credentials are not legal request fields."
 *
 * The absence is the contract. There is no `allowed`, no `approved`, no `authorized` field
 * on the result, and no place to put one. A gateway that returns an authorization is a
 * gateway that lets a prompt injection grant itself permission, and the only durable defence
 * is that the field does not exist for the model to fill in.
 */

export const COGNITION_PURPOSES = [
  'plan',
  'code',
  'debug',
  'summarize',
  'classify',
  'voice',
  'reflect',
] as const;
export const CognitionPurpose = z.enum(COGNITION_PURPOSES);
export type CognitionPurpose = z.infer<typeof CognitionPurpose>;

export const QUALITY_TIERS = ['economy', 'standard', 'high'] as const;

export const ProviderConstraints = z.object({
  /** Data residency. An empty list means "no constraint", not "anywhere is fine". */
  regions: z.array(z.string().regex(/^[a-z]{2,8}$/)).max(8),
  retention: z.enum(['disabled', 'zero_day', 'provider_default']),
  /** Tenant allow-list of provider ids. Enforced before routing, not after. */
  allowed_providers: z.array(z.string().max(64)).max(32).optional(),
});
export type ProviderConstraints = z.infer<typeof ProviderConstraints>;

export const CognitionRequest = envelopeExtend({
  schema: z.literal('agentdev.cognition_request.v2'),
  id: CognitionRequestId,
  agent_id: AgentId,
  workflow_id: WorkflowId,
  purpose: CognitionPurpose,
  risk: RiskLevel,
  data_classes: DataClassSet,
  /**
   * Which parts of the assembled context are attacker-controlled. The context builder puts
   * them in section 5, explicitly delimited; the router uses them to pick a route.
   */
  untrusted_sources: z.array(BoundedText(64)).max(32),
  required_capabilities: z.array(BoundedText(64)).max(16),
  quality_tier: z.enum(QUALITY_TIERS),
  latency_budget_ms: z.number().int().positive(),
  cost_budget_usd: z.number().nonnegative(),
  /** Context by reference. The request never carries the context itself. */
  context_refs: z.array(ContextId).max(32),
  /** Structured output is mandatory; a prose response is a failed response. */
  response_schema: z.string().min(1).max(128),
  provider_constraints: ProviderConstraints,
});
export type CognitionRequest = z.infer<typeof CognitionRequest>;

export const CognitionUsage = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  latency_ms: z.number().int().nonnegative(),
});
export type CognitionUsage = z.infer<typeof CognitionUsage>;

export const CognitionResult = envelopeExtend({
  schema: z.literal('agentdev.cognition_result.v2'),
  request_id: CognitionRequestId,
  workflow_id: WorkflowId,
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  model_version: z.string().min(1).max(64),
  prompt_template: z.object({
    version: z.string().min(1).max(64),
    digest: Sha256Digest,
  }),
  /** What was actually sent, as a digest. Reproducibility without retaining the prompt. */
  authorized_context_digest: Sha256Digest,
  /** Validated against `response_schema` before the result is constructed. */
  content: z.unknown(),
  schema_verdict: z.enum(['valid', 'invalid', 'not_applicable']),
  usage: CognitionUsage,
  /** The model's own uncertainty, when it can express it. Advisory, never authorising. */
  uncertainty: z.number().min(0).max(1).nullable(),
  citations: z.array(AnyRef).max(64),
  completion_reason: z.enum(['stop', 'length', 'schema_retry_exhausted', 'cancelled', 'error']),
  completed_at: Rfc3339Utc,
});
export type CognitionResult = z.infer<typeof CognitionResult>;

/**
 * Field names a cognition result may never carry, checked in a contract test.
 *
 * Listing them is not paranoia about today's schema — it is a tripwire for the future. The
 * pressure to add "the model said this was fine" arrives eventually, and it should arrive as
 * a failing test in `packages/contracts` where someone has to argue for it.
 */
export const FORBIDDEN_COGNITION_RESULT_FIELDS = [
  'allowed',
  'approved',
  'authorized',
  'authorised',
  'permission',
  'permissions',
  'decision',
  'policy_decision',
  'capability',
  'grant',
] as const;
