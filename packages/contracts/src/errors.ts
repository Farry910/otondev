import { z } from 'zod';
import { Rfc3339Utc } from './primitives.js';
import { redact } from './redaction.js';
import { WorkflowState } from './workflow-states.js';
import type { WorkflowState as WorkflowStateT } from './workflow-states.js';

/**
 * The error contract, contracts §11.
 *
 *   "Errors contain stable `code`, retryability, safe public message, internal diagnostic
 *    reference, owning component, and recommended state transition. Never embed raw provider
 *    responses or secret-bearing commands in the public message."
 *
 * The public message is looked up from the table below and is never derived from input. That
 * is the whole point: a message assembled from a provider response is exactly how a token
 * ends up in a ticket comment. Anything caller-specific goes in `details`, which is redacted
 * and truncated, or behind `diagnostic_ref`, which is an opaque pointer into the audit log.
 */

export const COMPONENTS = [
  'ingress', // S1
  'workflow', // S2
  'core', // S3
  'policy', // S4
  'broker', // S5
  'cognition', // S6
  'connectors', // S7
  'audit', // S8
  'evidence', // S9
  'workspace', // S10
  'executor', // S11
  'verifier', // S12
  'memory', // S13
  'presence', // S15
  'companion', // S16
  'supervisor', // S17
  'operator', // S18
  'eval', // S19
  'integration', // S20
  'contracts', // W0
  'sdk', // W0
] as const;
export const Component = z.enum(COMPONENTS);
export type Component = z.infer<typeof Component>;

interface ErrorSpec {
  /** May the caller retry the identical request and expect a different outcome? */
  retryable: boolean;
  /** Safe to show a human or a ticket. Contains no input, no provider text, no secret. */
  message: string;
  component: Component;
  /** Where the owning workflow should go. `null` = the error does not move the workflow. */
  transition: WorkflowStateT | null;
}

/**
 * The registry. §11 names eight codes as examples; the rest are the codes the package briefs
 * in implementation-plan §5 require in order to state their exit criteria. Adding a code is
 * an additive contract change (§6 rule 3); changing the meaning of one is not.
 */
export const ERROR_SPECS = {
  // ---- envelope, schema, versioning (W0) ---------------------------------------
  ENVELOPE_INVALID: {
    retryable: false,
    message: 'The record envelope is malformed.',
    component: 'contracts',
    transition: null,
  },
  SCHEMA_UNKNOWN: {
    retryable: false,
    message: 'The record declares a schema this deployment does not know.',
    component: 'contracts',
    transition: null,
  },
  SCHEMA_MAJOR_UNSUPPORTED: {
    retryable: false,
    message: 'The record declares a schema major version this deployment does not support.',
    component: 'contracts',
    transition: null,
  },
  SCHEMA_VALIDATION_FAILED: {
    retryable: false,
    message: 'The record does not satisfy its declared schema.',
    component: 'contracts',
    transition: null,
  },
  PAYLOAD_TOO_LARGE: {
    retryable: false,
    message: 'The payload exceeds the inline size bound; use an artifact reference.',
    component: 'contracts',
    transition: null,
  },

  // ---- ingress (S1) -------------------------------------------------------------
  SIGNATURE_INVALID: {
    retryable: false,
    message: 'The request signature did not verify.',
    component: 'ingress',
    transition: null,
  },
  REPLAY_DETECTED: {
    retryable: false,
    message: 'The request falls outside the accepted replay window.',
    component: 'ingress',
    transition: null,
  },
  DUPLICATE_EVENT: {
    retryable: false,
    message: 'This source event has already been accepted; the original canonical ID stands.',
    component: 'ingress',
    transition: null,
  },
  SOURCE_VERSION_STALE: {
    retryable: false,
    message: 'A newer version of this subject has already been processed.',
    component: 'ingress',
    transition: null,
  },

  // ---- workflow (S2) ------------------------------------------------------------
  STATE_VERSION_CONFLICT: {
    retryable: true,
    message: 'The workflow changed since it was read; re-read and retry.',
    component: 'workflow',
    transition: null,
  },
  INVALID_STATE_TRANSITION: {
    retryable: false,
    message: 'That state transition is not permitted from the current state.',
    component: 'workflow',
    transition: null,
  },
  LEASE_FENCED: {
    retryable: false,
    message: 'The lease has been superseded; this worker is fenced and must stop.',
    component: 'workflow',
    transition: 'RECOVERING',
  },
  LEASE_EXPIRED: {
    retryable: false,
    message: 'The lease expired before the write landed.',
    component: 'workflow',
    transition: 'RECOVERING',
  },
  WORKFLOW_TERMINAL: {
    retryable: false,
    message: 'The workflow is in a terminal state; create a new workflow to retry.',
    component: 'workflow',
    transition: null,
  },

  // ---- policy and approval (S4) --------------------------------------------------
  POLICY_DENIED: {
    retryable: false,
    message: 'Policy denied this action.',
    component: 'policy',
    transition: 'BLOCKED',
  },
  POLICY_INPUT_UNKNOWN: {
    retryable: false,
    message: 'Policy could not evaluate an input it does not recognise, so it denied.',
    component: 'policy',
    transition: 'BLOCKED',
  },
  APPROVAL_REQUIRED: {
    retryable: false,
    message: 'This action requires an explicit human approval that does not yet exist.',
    component: 'policy',
    transition: 'WAITING_AUTH',
  },
  APPROVAL_EXPIRED: {
    retryable: false,
    message: 'The approval has expired.',
    component: 'policy',
    transition: 'WAITING_AUTH',
  },
  APPROVAL_CONSUMED: {
    retryable: false,
    message: 'The approval has already been used the number of times it permits.',
    component: 'policy',
    transition: 'WAITING_AUTH',
  },
  APPROVAL_BINDING_MISMATCH: {
    retryable: false,
    message: 'The request does not match the actor, action, resource or parameters approved.',
    component: 'policy',
    transition: 'WAITING_AUTH',
  },

  // ---- capability broker (S5) ----------------------------------------------------
  CAPABILITY_INVALID: {
    retryable: false,
    message: 'The capability did not verify.',
    component: 'broker',
    transition: null,
  },
  CAPABILITY_EXPIRED: {
    retryable: false,
    message: 'The capability has expired.',
    component: 'broker',
    transition: null,
  },
  CAPABILITY_REVOKED: {
    retryable: false,
    message: 'The capability was revoked or its revocation epoch has moved on.',
    component: 'broker',
    transition: 'PAUSED',
  },
  CAPABILITY_EXHAUSTED: {
    retryable: false,
    message: 'The capability has been used the number of times it permits.',
    component: 'broker',
    transition: null,
  },
  CAPABILITY_PARAMETER_MISMATCH: {
    retryable: false,
    message: 'The call parameters do not match the digest the capability is bound to.',
    component: 'broker',
    transition: null,
  },

  // ---- cognition (S6) -------------------------------------------------------------
  DATA_PROVIDER_FORBIDDEN: {
    retryable: false,
    message: 'No permitted provider can handle this request under its data policy.',
    component: 'cognition',
    transition: 'BLOCKED',
  },
  STRUCTURED_OUTPUT_INVALID: {
    retryable: true,
    message: 'The model response did not satisfy the required output schema.',
    component: 'cognition',
    transition: null,
  },
  BUDGET_EXHAUSTED: {
    retryable: false,
    message: 'The budget for this workflow is exhausted.',
    component: 'cognition',
    transition: 'PAUSED',
  },
  PROVIDER_UNAVAILABLE: {
    retryable: true,
    message: 'The selected provider is unavailable.',
    component: 'cognition',
    transition: null,
  },
  CONTEXT_TOO_LARGE: {
    retryable: false,
    message: 'The authorized context exceeds the size limit for every permitted route.',
    component: 'cognition',
    transition: null,
  },

  // ---- connectors (S7) --------------------------------------------------------------
  ACTION_OUTCOME_UNKNOWN: {
    retryable: false,
    message: 'The outcome of the external action is unknown and must be reconciled first.',
    component: 'connectors',
    transition: 'RECOVERING',
  },
  IDEMPOTENCY_CONFLICT: {
    retryable: false,
    message: 'An action with this idempotency key exists with different parameters.',
    component: 'connectors',
    transition: null,
  },
  RATE_LIMITED: {
    retryable: true,
    message: 'The provider is rate limiting this client.',
    component: 'connectors',
    transition: null,
  },
  COMPENSATION_UNAVAILABLE: {
    retryable: false,
    message: 'This action class cannot be compensated automatically.',
    component: 'connectors',
    transition: 'BLOCKED',
  },

  // ---- evidence (S9), workspace (S10), executor (S11), verifier (S12) ---------------
  EVIDENCE_INCOMPLETE: {
    retryable: false,
    message: 'The evidence bundle is incomplete; delivery is refused.',
    component: 'evidence',
    transition: 'EXECUTING',
  },
  EVIDENCE_IMMUTABLE: {
    retryable: false,
    message: 'An evidence bundle cannot be modified; publish a superseding bundle.',
    component: 'evidence',
    transition: null,
  },
  WORKSPACE_QUOTA_EXCEEDED: {
    retryable: false,
    message: 'The workspace exceeded a CPU, memory, disk, time or spend limit and was stopped.',
    component: 'workspace',
    transition: 'FAILED',
  },
  WORKSPACE_QUARANTINED: {
    retryable: false,
    message: 'The workspace was quarantined and cannot continue.',
    component: 'workspace',
    transition: 'FAILED',
  },
  TOOL_NOT_PERMITTED: {
    retryable: false,
    message: 'The requested executable or argument is not on the allow-list.',
    component: 'executor',
    transition: null,
  },
  BASE_SHA_CHANGED: {
    retryable: false,
    message: 'The base commit moved during execution; the plan must be rebuilt.',
    component: 'executor',
    transition: 'PLANNED',
  },
  VERIFY_FAILED: {
    retryable: false,
    message: 'Independent verification failed.',
    component: 'verifier',
    transition: 'EXECUTING',
  },
  VERIFY_MANIFEST_INVALID: {
    retryable: false,
    message: 'The verifier manifest is invalid or declares an unsupported version.',
    component: 'verifier',
    transition: 'BLOCKED',
  },

  // ---- memory (S13) --------------------------------------------------------------------
  MEMORY_PROVENANCE_MISSING: {
    retryable: false,
    message: 'The memory record has no usable provenance and was not stored.',
    component: 'memory',
    transition: null,
  },
  MEMORY_QUARANTINED: {
    retryable: false,
    message: 'The candidate record was quarantined during ingestion.',
    component: 'memory',
    transition: null,
  },

  // ---- presence (S15) -------------------------------------------------------------------
  PRESENCE_CONSENT_REQUIRED: {
    retryable: false,
    message: 'Recording or participation consent has not been established.',
    component: 'presence',
    transition: 'WAITING_INPUT',
  },
  PRESENCE_UNGROUNDED_RESPONSE: {
    retryable: false,
    message: 'The response was not grounded in authorized evidence and was withheld.',
    component: 'presence',
    transition: null,
  },

  // ---- cross-cutting -----------------------------------------------------------------------
  EMERGENCY_STOP_ACTIVE: {
    retryable: false,
    message: 'An emergency stop is active; no new work or capabilities are being issued.',
    component: 'operator',
    transition: 'PAUSED',
  },
  OPERATOR_PAUSED: {
    retryable: false,
    message: 'An operator has paused this agent or workflow.',
    component: 'operator',
    transition: 'PAUSED',
  },
  TENANT_ISOLATION_VIOLATION: {
    retryable: false,
    message: 'The request crosses a tenant boundary and was refused.',
    component: 'policy',
    transition: 'BLOCKED',
  },
  TIMEOUT: {
    retryable: true,
    message: 'The operation exceeded its time budget.',
    component: 'sdk',
    transition: null,
  },
  INTERNAL: {
    retryable: false,
    message: 'An internal error occurred.',
    component: 'sdk',
    transition: null,
  },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERROR_SPECS;

export const ERROR_CODES = Object.keys(ERROR_SPECS) as [ErrorCode, ...ErrorCode[]];
export const ErrorCode = z.enum(ERROR_CODES);

/** Bounded so no single field can turn a log line into a payload. */
const DetailValue = z.union([z.string().max(256), z.number(), z.boolean(), z.null()]);

export const ErrorContract = z.object({
  schema: z.literal('agentdev.error.v2'),
  code: ErrorCode,
  retryable: z.boolean(),
  /** Never derived from input. See the module comment. */
  public_message: z.string().min(1).max(256),
  /** Opaque pointer into the audit log; the only route to the underlying detail. */
  diagnostic_ref: z.string().min(1).max(128),
  component: Component,
  recommended_transition: WorkflowState.nullable(),
  occurred_at: Rfc3339Utc,
  /** Redacted and truncated at construction. Structured, never prose. */
  details: z.record(z.string().max(64), DetailValue).optional(),
});
export type ErrorContract = z.infer<typeof ErrorContract>;

export interface MakeErrorOptions {
  diagnostic_ref: string;
  occurred_at: string;
  details?: Record<string, string | number | boolean | null>;
  /** Override the registry default when the caller knows better (e.g. a fenced worker). */
  recommended_transition?: WorkflowStateT | null;
  component?: Component;
}

/**
 * The only supported way to build an {@link ErrorContract}.
 *
 * `public_message` comes from the registry, so no caller can put a provider response in it
 * even by accident; `details` is passed through the redactor so a secret-class key cannot
 * ride along.
 */
export function makeError(code: ErrorCode, options: MakeErrorOptions): ErrorContract {
  const spec: ErrorSpec = ERROR_SPECS[code];
  const base = {
    schema: 'agentdev.error.v2',
    code,
    retryable: spec.retryable,
    public_message: spec.message,
    diagnostic_ref: options.diagnostic_ref,
    component: options.component ?? spec.component,
    recommended_transition:
      options.recommended_transition === undefined
        ? spec.transition
        : options.recommended_transition,
    occurred_at: options.occurred_at,
  } satisfies Omit<ErrorContract, 'details'>;

  if (options.details === undefined) return base;
  return {
    ...base,
    details: redact(options.details, { maxStringLength: 256 }) as ErrorContract['details'],
  };
}

/**
 * A thrown error that carries its contract. Services convert at the boundary; nothing
 * crosses a service boundary as a bare `Error`.
 */
export class ContractError extends Error {
  readonly contract: ErrorContract;

  constructor(contract: ErrorContract) {
    super(`${contract.code}: ${contract.public_message}`);
    this.name = 'ContractError';
    this.contract = contract;
  }

  get code(): ErrorCode {
    return this.contract.code;
  }

  get retryable(): boolean {
    return this.contract.retryable;
  }
}

export function isContractError(value: unknown): value is ContractError {
  return value instanceof ContractError;
}
