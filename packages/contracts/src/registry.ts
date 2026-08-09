import type { z } from 'zod';
import { toIssues, withinSizeBound } from './envelope.js';
import type { ValidationResult } from './envelope.js';
import { negotiate } from './versioning.js';
import { IngressEvent } from './event.js';
import { WorkflowRecord, WorkflowTransition } from './workflow.js';
import { ExecutionCommand, Plan } from './plan.js';
import { Approval, DecisionRequest, PolicyDecision } from './policy.js';
import { Capability } from './capability.js';
import { ExternalAction } from './action.js';
import { CognitionRequest, CognitionResult } from './cognition.js';
import { MemoryRecord } from './memory.js';
import { EvidenceBundle } from './evidence.js';
import { AuditRecord } from './audit.js';
import { ErrorContract } from './errors.js';

/**
 * Every schema in contracts-and-data.md, in one place, keyed by the identifier that appears
 * on the wire.
 *
 * One registry is what makes the rest possible: version negotiation can refuse a schema it
 * has no entry for, the JSON Schema emitter can iterate it so no schema is ever missing from
 * the cross-language artifacts, and the "no secret-class field exists anywhere" test has
 * something finite to check. A schema that is not registered is invisible to all three, so
 * registration is not optional bookkeeping.
 */
export const SCHEMA_REGISTRY = {
  'agentdev.event.v2': IngressEvent,
  'agentdev.workflow.v2': WorkflowRecord,
  'agentdev.transition.v2': WorkflowTransition,
  'agentdev.plan.v2': Plan,
  'agentdev.execution_command.v2': ExecutionCommand,
  'agentdev.policy_decision.v2': PolicyDecision,
  'agentdev.approval.v2': Approval,
  'agentdev.decision_request.v2': DecisionRequest,
  'agentdev.capability.v2': Capability,
  'agentdev.action.v2': ExternalAction,
  'agentdev.cognition_request.v2': CognitionRequest,
  'agentdev.cognition_result.v2': CognitionResult,
  'agentdev.memory.v2': MemoryRecord,
  'agentdev.evidence.v2': EvidenceBundle,
  'agentdev.audit.v2': AuditRecord,
  'agentdev.error.v2': ErrorContract,
} as const;

export type RegisteredSchemaId = keyof typeof SCHEMA_REGISTRY;
export type RegisteredRecord = {
  [K in RegisteredSchemaId]: z.infer<(typeof SCHEMA_REGISTRY)[K]>;
}[RegisteredSchemaId];

export const REGISTERED_SCHEMA_IDS = Object.keys(SCHEMA_REGISTRY) as RegisteredSchemaId[];

export function isRegisteredSchemaId(id: string): id is RegisteredSchemaId {
  return Object.hasOwn(SCHEMA_REGISTRY, id);
}

/**
 * Parse an untrusted record: negotiate the version, then validate against the registered
 * schema, then check the size bound.
 *
 * The order matters and the failure is closed at every step. A record with an unsupported
 * major is refused before its fields are read, because reading fields defined by a contract
 * you do not implement is how you end up honouring half of one.
 */
export function parseRecord(input: unknown): ValidationResult<RegisteredRecord> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      failure: { code: 'ENVELOPE_INVALID', issues: [{ path: '#', code: 'invalid_type', message: 'expected an object' }] },
    };
  }

  const declared = (input as Record<string, unknown>)['schema'];
  if (typeof declared !== 'string') {
    return {
      ok: false,
      failure: {
        code: 'ENVELOPE_INVALID',
        issues: [{ path: 'schema', code: 'invalid_type', message: 'expected a schema identifier' }],
      },
    };
  }

  const negotiation = negotiate(declared);
  if (!negotiation.ok) {
    const { failure } = negotiation;
    const code = failure.reason === 'unsupported_major' ? 'SCHEMA_MAJOR_UNSUPPORTED' : failure.reason === 'unknown_type' ? 'SCHEMA_UNKNOWN' : 'ENVELOPE_INVALID';
    return {
      ok: false,
      failure: {
        code,
        issues: [
          {
            path: 'schema',
            code: failure.reason,
            message:
              failure.reason === 'unsupported_major'
                ? `major ${failure.major} is outside the supported window [${failure.supported.join(', ')}]`
                : `"${failure.raw}" is not a schema this build reads`,
          },
        ],
      },
    };
  }

  if (!isRegisteredSchemaId(declared)) {
    // Negotiation knows the type but no schema is registered for it. That is a build defect,
    // not bad input, and it must not be reported as a caller error that the caller can fix.
    return {
      ok: false,
      failure: {
        code: 'SCHEMA_UNKNOWN',
        issues: [{ path: 'schema', code: 'unregistered', message: `${declared} is negotiable but has no registered schema` }],
      },
    };
  }

  if (!withinSizeBound(input)) {
    return {
      ok: false,
      failure: {
        code: 'PAYLOAD_TOO_LARGE',
        issues: [{ path: '#', code: 'too_big', message: 'record exceeds the inline size bound' }],
      },
    };
  }

  const result = SCHEMA_REGISTRY[declared].safeParse(input);
  if (!result.success) {
    return { ok: false, failure: { code: 'SCHEMA_VALIDATION_FAILED', issues: toIssues(result.error) } };
  }
  return { ok: true, value: result.data as RegisteredRecord };
}

/** Typed variant for a caller that already knows what it expects. */
export function parseAs<K extends RegisteredSchemaId>(
  id: K,
  input: unknown,
): ValidationResult<z.infer<(typeof SCHEMA_REGISTRY)[K]>> {
  const parsed = parseRecord(input);
  if (!parsed.ok) return parsed;
  const declared = (input as Record<string, unknown>)['schema'];
  if (declared !== id) {
    return {
      ok: false,
      failure: {
        code: 'SCHEMA_VALIDATION_FAILED',
        issues: [{ path: 'schema', code: 'invalid_value', message: `expected ${id}` }],
      },
    };
  }
  return { ok: true, value: parsed.value as z.infer<(typeof SCHEMA_REGISTRY)[K]> };
}
