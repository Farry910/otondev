import { FORBIDDEN_COGNITION_RESULT_FIELDS } from '@otondev/contracts';

/**
 * Structured-output validation — routing step 8, "validate syntax/schema, citations/evidence
 * references, and forbidden fields".
 *
 * Two separate jobs, and they fail differently:
 *
 *   **Schema validation** is a quality gate. A response that misses the schema is retryable —
 *   the model may do better on a second attempt — and it returns a typed error, never prose.
 *   `STRUCTURED_OUTPUT_INVALID` exists precisely so the caller gets a machine-readable failure
 *   instead of an apology it would have to parse.
 *
 *   **Forbidden-field rejection** is a security gate, and it is not retryable. A response
 *   carrying `approved: true` is not a formatting mistake; it is either a confused model or a
 *   successful injection, and both must fail closed. The check is recursive because a nested
 *   `{"decision": {"approved": true}}` authorises exactly as effectively as a top-level one,
 *   and only checking the top level is the kind of gap that reads as thorough.
 */

export type ValidationFailure =
  | { readonly kind: 'schema'; readonly detail: string }
  | { readonly kind: 'forbidden_field'; readonly path: string; readonly field: string }
  | { readonly kind: 'unknown_schema'; readonly schema: string };

export type ValidationOutcome<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ValidationFailure };

/** A response-schema validator. Anything that can say yes-with-a-value or no-with-a-reason. */
export interface ResponseSchema<T = unknown> {
  readonly name: string;
  validate(value: unknown): { ok: true; value: T } | { ok: false; detail: string };
}

/**
 * The set of `response_schema` names this deployment will honour.
 *
 * An unregistered schema is refused rather than waved through. "Structured output is
 * mandatory; a prose response is a failed response" (the request contract) is unenforceable if
 * the gateway will accept a schema name it cannot check — the request would look validated and
 * be nothing of the kind.
 */
export class ResponseSchemaRegistry {
  readonly #schemas = new Map<string, ResponseSchema>();

  register(schema: ResponseSchema): this {
    this.#schemas.set(schema.name, schema);
    return this;
  }

  has(name: string): boolean {
    return this.#schemas.has(name);
  }

  get(name: string): ResponseSchema | undefined {
    return this.#schemas.get(name);
  }
}

const FORBIDDEN = new Set<string>(FORBIDDEN_COGNITION_RESULT_FIELDS);

/**
 * Walk the response for any authorization-shaped field, at any depth.
 *
 * The forbidden list lives in `packages/contracts` next to the result schema, so the tripwire
 * and the contract it protects cannot drift apart.
 */
export function findForbiddenField(
  value: unknown,
  path = '$',
  seen = new WeakSet<object>(),
): { path: string; field: string } | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const hit = findForbiddenField(item, `${path}[${index}]`, seen);
      if (hit) return hit;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.has(key.toLowerCase())) {
      return { path: `${path}.${key}`, field: key };
    }
    const hit = findForbiddenField(child, `${path}.${key}`, seen);
    if (hit) return hit;
  }
  return null;
}

export function validateResponse(
  content: unknown,
  schemaName: string,
  registry: ResponseSchemaRegistry,
): ValidationOutcome {
  const schema = registry.get(schemaName);
  if (schema === undefined) {
    return { ok: false, failure: { kind: 'unknown_schema', schema: schemaName } };
  }

  // Forbidden fields are checked before the schema. A schema that happens to permit an
  // `approved` field would otherwise validate the response and hand back an authorization,
  // and the ordering is the only thing preventing that.
  const forbidden = findForbiddenField(content);
  if (forbidden) {
    return { ok: false, failure: { kind: 'forbidden_field', ...forbidden } };
  }

  const result = schema.validate(content);
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, failure: { kind: 'schema', detail: result.detail } };
}

/** Convenience for the common case of a Zod-like `safeParse`. */
export function schemaFrom<T>(
  name: string,
  parse: (value: unknown) => { success: boolean; data?: T; error?: { message: string } },
): ResponseSchema<T> {
  return {
    name,
    validate(value) {
      const result = parse(value);
      return result.success && result.data !== undefined
        ? { ok: true, value: result.data }
        : { ok: false, detail: result.error?.message ?? 'did not satisfy the response schema' };
    },
  };
}
