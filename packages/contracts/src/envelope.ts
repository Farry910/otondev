import { z } from 'zod';
import { CorrelationId, TenantId, AgentId, WorkflowId } from './ids.js';
import {
  DataClassSet,
  Integrity,
  Producer,
  Rfc3339Utc,
  TraceContext,
  MAX_INLINE_PAYLOAD_BYTES,
} from './primitives.js';
import { SchemaId } from './versioning.js';

/**
 * The common envelope, contracts §1. Every event, command, decision, result and evidence
 * record carries it.
 *
 * Note which fields are *not* optional. `tenant_id` is mandatory everywhere because it "is
 * always part of storage keys and authorization checks" — a record that reaches storage
 * without one is an isolation bug that a nullable column would hide. `correlation_id` is
 * mandatory because without it an incident is unreconstructable, and reconstructing an
 * incident is the entire premise of the audit design.
 */

/** Any platform-minted identifier: `<prefix>_<26-char ULID>`. */
export const MintedId = z
  .string()
  .regex(/^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/, 'expected a platform-minted `<prefix>_<ULID>` id');

export const Envelope = z.object({
  schema: SchemaId,
  id: MintedId,
  tenant_id: TenantId,
  /** Optional only before assignment (contracts §1). */
  agent_id: AgentId.optional(),
  /** Optional only for ingress (contracts §1). */
  workflow_id: WorkflowId.optional(),
  correlation_id: CorrelationId,
  /** The record that caused this one. Absent on a root record, never empty. */
  causation_id: MintedId.optional(),
  created_at: Rfc3339Utc,
  producer: Producer,
  data_classes: DataClassSet,
  integrity: Integrity,
  trace: TraceContext.optional(),
});
export type Envelope = z.infer<typeof Envelope>;

/** Build a record schema by extending the envelope. Every schema in this package uses it. */
export function envelopeExtend<T extends z.ZodRawShape>(shape: T) {
  return Envelope.extend(shape);
}

export type ValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type ValidationFailureCode =
  | 'ENVELOPE_INVALID'
  | 'SCHEMA_UNKNOWN'
  | 'SCHEMA_MAJOR_UNSUPPORTED'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'PAYLOAD_TOO_LARGE';

export interface ValidationFailure {
  code: ValidationFailureCode;
  issues: ValidationIssue[];
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ValidationFailure };

/**
 * Zod issues, reduced to path + code + message.
 *
 * The offending *value* is deliberately dropped. Validation failures are logged, and the
 * value that failed validation is exactly the kind of thing that turns out to be a token
 * someone pasted into a ticket description.
 */
export function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? '#' : issue.path.map(String).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

/** Contracts §1: "Payload sizes are bounded; large values use encrypted artifact references." */
export function withinSizeBound(value: unknown, max = MAX_INLINE_PAYLOAD_BYTES): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') <= max;
  } catch {
    // Unserialisable (a cycle, a BigInt) is not "within bound", it is not a record.
    return false;
  }
}

/**
 * Validate the envelope alone, without knowing the record type.
 *
 * Used by anything that has to route a record before it can parse it — the audit writer, the
 * dead-letter path, the dispatcher.
 */
export function parseEnvelope(input: unknown): ValidationResult<Envelope> {
  const result = Envelope.safeParse(input);
  if (!result.success) {
    return { ok: false, failure: { code: 'ENVELOPE_INVALID', issues: toIssues(result.error) } };
  }
  return { ok: true, value: result.data };
}
