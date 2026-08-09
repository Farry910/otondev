/**
 * Redaction by schema, not by string matching (contracts §1).
 *
 *   "Secret values are illegal in contracts. Logs redact/hide fields by schema, not only
 *    string matching."
 *
 * Two mechanisms, in order of strength:
 *
 *   1. `SECRET_FIELD_NAMES` — a field with one of these names may not appear in any
 *      registered schema. `assertNoSecretFields` proves that over the whole registry in a
 *      test, so the guarantee is structural: there is no field to leak.
 *   2. `redact` — a value walker for the boundary where structure is lost anyway: log lines,
 *      error details, span attributes. Defence in depth for data that reached us from
 *      outside a schema.
 *
 * String scanning of *values* is deliberately absent. It produces false confidence: it
 * cannot see a base64 token, and it mangles legitimate content. The primary protection is
 * that a credential is never fetched into a record in the first place (S5: the broker never
 * returns a secret value to a caller).
 */

export const REDACTED = '[redacted]';

/**
 * Field names that may never carry a value in a contract, a log, or a span attribute.
 * Matching is case-insensitive and on word boundaries, so `github_api_key` and `apiKey`
 * both match while `tokenizer` does not.
 */
export const SECRET_FIELD_NAMES = [
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'private_key',
  'client_secret',
  'session_key',
  'cookie',
  'set_cookie',
  'bearer',
  'passphrase',
  'pin',
  'otp',
  'dpapi_blob',
  'vault_value',
] as const;

/**
 * Names that contain a secret-class segment but are not secrets. Each one is a real field in
 * a normative contract, so without this list the registry check below would either be turned
 * off or turned into a lie.
 *
 * Every entry needs a reason. "It was noisy" is not a reason.
 */
export const NON_SECRET_FIELD_NAMES = [
  'fencing_token', // contracts §3/§6 — a monotonic counter, published in the capability
  'lease_fencing_token', // contracts §6 — same counter, quoted by the connector
  'cancellation_token', // contracts §4 — an ExecutionCommand handle, not a credential
  'continuation_token', // pagination
  'page_token',
  'next_page_token',
  'token_count', // cognition usage accounting (contracts §8)
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cached_tokens',
  'tokens_used',
] as const;

const NORMALISE = /[^a-z0-9]/g;

const SECRET_SET = new Set<string>(SECRET_FIELD_NAMES.map((n) => n.replace(NORMALISE, '')));
const ALLOWED_SET = new Set<string>(NON_SECRET_FIELD_NAMES.map((n) => n.replace(NORMALISE, '')));

/**
 * A field name is secret-class if any run of its underscore/camel-case segments, or the whole
 * normalised name, is in the registry and the whole name is not explicitly allowed.
 *
 * `client_secret` is secret. `broker_signature` is not — a signature is meant to be public.
 * `lease_fencing_token` is not, and is listed above with its reason.
 */
export function isSecretFieldName(name: string): boolean {
  const normalised = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const flat = normalised.replace(NORMALISE, '');
  if (ALLOWED_SET.has(flat)) return false;
  if (SECRET_SET.has(flat)) return true;
  const segments = normalised.split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j <= segments.length; j += 1) {
      if (SECRET_SET.has(segments.slice(i, j).join(''))) return true;
    }
  }
  return false;
}

export interface RedactOptions {
  /** Values longer than this are truncated. Keeps one oversized field from filling a log. */
  maxStringLength?: number;
  /** Depth beyond which the value is replaced by a marker rather than walked. */
  maxDepth?: number;
}

/**
 * Deep-copy `value`, replacing every secret-class field with {@link REDACTED}.
 *
 * Cycles are replaced with `[circular]` rather than throwing: a logger that crashes on a
 * self-referential object turns a small bug into an outage.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const maxStringLength = options.maxStringLength ?? 2048;
  const maxDepth = options.maxDepth ?? 12;
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || node === undefined) return node;
    if (typeof node === 'string') {
      return node.length > maxStringLength ? `${node.slice(0, maxStringLength)}…[truncated]` : node;
    }
    if (typeof node === 'number' || typeof node === 'boolean') return node;
    if (typeof node === 'bigint') return node.toString();
    if (typeof node === 'function' || typeof node === 'symbol') return `[${typeof node}]`;
    if (depth > maxDepth) return '[max-depth]';

    if (typeof node === 'object') {
      if (seen.has(node)) return '[circular]';
      seen.add(node);
      if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
      if (node instanceof Date) return node.toISOString();
      if (node instanceof Error) {
        return { name: node.name, message: walk(node.message, depth + 1) };
      }
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = isSecretFieldName(key) ? REDACTED : walk(child, depth + 1);
      }
      return out;
    }
    return '[unknown]';
  };

  return walk(value, 0);
}

/**
 * Walk an emitted JSON Schema and collect every property name that is secret-class.
 *
 * This is the structural half of the guarantee: run over the whole registry, an empty result
 * means no registered contract has anywhere to put a credential. S8's "no secret-class field
 * is persistable by construction" rests on it.
 */
export function findSecretFields(jsonSchema: unknown, path = '#'): string[] {
  const found: string[] = [];
  const visit = (node: unknown, at: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${at}/${i}`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'properties' && child !== null && typeof child === 'object') {
        for (const propName of Object.keys(child as Record<string, unknown>)) {
          if (isSecretFieldName(propName)) found.push(`${at}/properties/${propName}`);
        }
      }
      visit(child, `${at}/${key}`);
    }
  };
  visit(jsonSchema, path);
  return found;
}
