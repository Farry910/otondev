import { z } from 'zod';

/**
 * Schema identity and version negotiation, contracts §1 and §12.
 *
 *   §1  "Schemas are backward-compatible within a major version; unknown major versions
 *        fail closed."
 *   §12 "Readers support current and one prior major version during rolling upgrade or use
 *        explicit migrators."
 *
 * Failing closed means all four of these are refusals, not warnings:
 *
 *   - an unparseable schema string
 *   - a schema type this build has never heard of
 *   - a major *older* than the supported window
 *   - a major *newer* than this build's current
 *
 * The last one is the one people get wrong. A newer major is the most dangerous input there
 * is: the sender believes it is speaking a language with different guarantees, and a reader
 * that best-effort parses it will silently drop the field that made it safe.
 */

export const SCHEMA_ID_RE = /^agentdev\.([a-z][a-z0-9_]*)\.v(\d+)$/;

export const SchemaId = z
  .string()
  .regex(SCHEMA_ID_RE, 'expected a schema id of the form agentdev.<type>.v<major>');

export interface ParsedSchemaId {
  raw: string;
  type: string;
  major: number;
}

export function parseSchemaId(raw: string): ParsedSchemaId | null {
  const m = SCHEMA_ID_RE.exec(raw);
  if (m === null) return null;
  const type = m[1];
  const major = m[2];
  if (type === undefined || major === undefined) return null;
  return { raw, type, major: Number(major) };
}

export function formatSchemaId(type: string, major: number): string {
  return `agentdev.${type}.v${major}`;
}

/**
 * Every schema type this build knows, and the majors it will read.
 *
 * `supported` is the reader window. It holds the current major and, during a rolling
 * upgrade, the one before it. Today every type is at v2 and there is no v1 in the wild, so
 * the window is exactly [2] — writing [1, 2] here would advertise a compatibility we have
 * not implemented, which is worse than not having it.
 */
export interface SchemaVersionPolicy {
  current: number;
  supported: readonly number[];
}

export const SCHEMA_VERSIONS = {
  // Named in contracts-and-data.md.
  event: { current: 2, supported: [2] },
  workflow: { current: 2, supported: [2] },
  plan: { current: 2, supported: [2] },
  policy_decision: { current: 2, supported: [2] },
  approval: { current: 2, supported: [2] },
  capability: { current: 2, supported: [2] },
  action: { current: 2, supported: [2] },
  memory: { current: 2, supported: [2] },
  evidence: { current: 2, supported: [2] },
  // Implied by the document and required to state a package's exit criteria. Defined by
  // W0 as the contract owner; additive from here on (implementation-plan §6 rule 3).
  execution_command: { current: 2, supported: [2] },
  decision_request: { current: 2, supported: [2] },
  transition: { current: 2, supported: [2] },
  cognition_request: { current: 2, supported: [2] },
  cognition_result: { current: 2, supported: [2] },
  audit: { current: 2, supported: [2] },
  error: { current: 2, supported: [2] },
} as const satisfies Record<string, SchemaVersionPolicy>;

export type SchemaType = keyof typeof SCHEMA_VERSIONS;

export const SCHEMA_TYPES = Object.keys(SCHEMA_VERSIONS) as [SchemaType, ...SchemaType[]];

export function isKnownSchemaType(type: string): type is SchemaType {
  return Object.hasOwn(SCHEMA_VERSIONS, type);
}

export type NegotiationFailure =
  | { reason: 'malformed'; raw: string }
  | { reason: 'unknown_type'; raw: string; type: string }
  | { reason: 'unsupported_major'; raw: string; type: SchemaType; major: number; supported: readonly number[] };

export type Negotiation =
  | { ok: true; type: SchemaType; major: number; current: boolean }
  | { ok: false; failure: NegotiationFailure };

/**
 * Decide whether this build may read a record bearing `raw`.
 *
 * Returns a result rather than throwing. A rejected schema is an ordinary, expected event
 * during a rolling upgrade — the caller turns it into a `SCHEMA_MAJOR_UNSUPPORTED` error and
 * a dead-letter, and an exception would make that path the unusual one.
 */
export function negotiate(raw: string): Negotiation {
  const parsed = parseSchemaId(raw);
  if (parsed === null) return { ok: false, failure: { reason: 'malformed', raw } };
  if (!isKnownSchemaType(parsed.type)) {
    return { ok: false, failure: { reason: 'unknown_type', raw, type: parsed.type } };
  }
  const policy: SchemaVersionPolicy = SCHEMA_VERSIONS[parsed.type];
  if (!policy.supported.includes(parsed.major)) {
    return {
      ok: false,
      failure: {
        reason: 'unsupported_major',
        raw,
        type: parsed.type,
        major: parsed.major,
        supported: policy.supported,
      },
    };
  }
  return {
    ok: true,
    type: parsed.type,
    major: parsed.major,
    current: parsed.major === policy.current,
  };
}

/** The schema id a producer in this build should stamp on a new record of `type`. */
export function currentSchemaId(type: SchemaType): string {
  return formatSchemaId(type, SCHEMA_VERSIONS[type].current);
}
