import { createHash } from 'node:crypto';

/**
 * Parameter normalisation and digesting.
 *
 * This is the smallest module in the service and the one everything else depends on being
 * exactly right. Contracts §5 binds an approval to a `parameter_digest`, and the S4 exit
 * criterion is that "editing any bound field invalidates an approval". Both reduce to a
 * single property:
 *
 *   **Two parameter sets digest the same if and only if they mean the same thing.**
 *
 * Get the "only if" wrong and an attacker edits a field without invalidating the approval.
 * Get the "if" wrong and every approval spuriously fails because a key was serialised in a
 * different order, which is worse in practice — people respond by loosening the check.
 *
 * So the encoding is canonical rather than "whatever JSON.stringify did":
 *
 *   - object keys sorted by code unit, recursively;
 *   - arrays keep their order, because `[a, b]` and `[b, a]` are different arguments;
 *   - `undefined` and absent are the same thing and are both dropped, because JSON cannot
 *     represent the difference and a round trip through storage would erase it anyway;
 *   - `null` is kept and is distinct from absent — "explicitly no value" is a real argument;
 *   - numbers are rejected unless finite, and `-0` is normalised to `0`;
 *   - strings are compared as-is: no case folding, no whitespace trimming, no Unicode
 *     normalisation. `--force` and `--Force` are different arguments, and a digest that
 *     folded them would approve one and execute the other.
 */

export type Normalisable =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Normalisable[]
  | { readonly [key: string]: Normalisable };

export class NonCanonicalValueError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`cannot canonicalise ${path}: ${detail}`);
    this.name = 'NonCanonicalValueError';
    this.path = path;
  }
}

/**
 * Canonical JSON text for `value`.
 *
 * Deliberately not `JSON.stringify` with a replacer: the replacer runs after the engine has
 * already chosen key order for objects, so it cannot make the output canonical.
 */
export function canonicalise(value: Normalisable, path = '$'): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number': {
      if (!Number.isFinite(value)) {
        // NaN and ±Infinity serialise to `null` in JSON, which would silently make two
        // different parameter sets digest identically.
        throw new NonCanonicalValueError(path, `${String(value)} has no JSON representation`);
      }
      // `-0` and `0` are the same argument; JSON.stringify already collapses them, but being
      // explicit means the invariant survives a change of serialiser.
      return JSON.stringify(value === 0 ? 0 : value);
    }

    case 'string':
      return JSON.stringify(value);

    case 'object': {
      if (Array.isArray(value)) {
        const items = value.map((item, index) =>
          // Order is meaning for an array, so an absent element cannot simply vanish the way
          // an absent object key can — it would shift every later argument left.
          item === undefined
            ? (() => {
                throw new NonCanonicalValueError(`${path}[${index}]`, 'undefined inside an array');
              })()
            : canonicalise(item, `${path}[${index}]`),
        );
        return `[${items.join(',')}]`;
      }

      const entries = Object.entries(value as Record<string, Normalisable>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const parts = entries.map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalise(item, `${path}.${key}`)}`,
      );
      return `{${parts.join(',')}}`;
    }

    default:
      throw new NonCanonicalValueError(path, `values of type ${typeof value} are not permitted`);
  }
}

/** `sha256:<64 hex>` over the canonical encoding. The form contracts §5 expects. */
export function parameterDigest(parameters: Normalisable): string {
  return `sha256:${createHash('sha256').update(canonicalise(parameters), 'utf8').digest('hex')}`;
}

/** Digest of an arbitrary already-canonical string. Used for plan and goal digests. */
export function digestOfText(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
