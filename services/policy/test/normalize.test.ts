import { describe, expect, it } from 'vitest';
import { canonicalise, parameterDigest, NonCanonicalValueError } from '../src/normalize.js';

/**
 * The digest is the linchpin of "editing any bound field invalidates an approval". Everything
 * else in S4 assumes this module has exactly two properties, so both get tested directly:
 * equal meaning ⇒ equal digest, and different meaning ⇒ different digest.
 */
describe('canonical encoding — equal meaning gives an equal digest', () => {
  it('ignores key order, at every depth', () => {
    const a = { b: 1, a: { d: 2, c: [1, 2, { f: 1, e: 2 }] } };
    const b = { a: { c: [1, 2, { e: 2, f: 1 }], d: 2 }, b: 1 };
    expect(parameterDigest(a)).toBe(parameterDigest(b));
  });

  it('treats an absent key and an explicit undefined as the same', () => {
    // They are the same after any round trip through JSON or a database, so treating them as
    // different would make a digest that cannot survive storage.
    expect(parameterDigest({ a: 1 })).toBe(parameterDigest({ a: 1, b: undefined }));
  });

  it('normalises negative zero', () => {
    expect(parameterDigest({ n: -0 })).toBe(parameterDigest({ n: 0 }));
  });
});

describe('canonical encoding — different meaning gives a different digest', () => {
  const base = { branch: 'agent/ENG-42', force: false, files: ['a.ts', 'b.ts'] };

  it('notices a changed value', () => {
    expect(parameterDigest({ ...base, force: true })).not.toBe(parameterDigest(base));
  });

  it('notices an added key', () => {
    expect(parameterDigest({ ...base, extra: 1 })).not.toBe(parameterDigest(base));
  });

  it('notices a removed key', () => {
    const { force: _dropped, ...without } = base;
    expect(parameterDigest(without)).not.toBe(parameterDigest(base));
  });

  it('notices reordered array elements — order is meaning for arguments', () => {
    expect(parameterDigest({ ...base, files: ['b.ts', 'a.ts'] })).not.toBe(parameterDigest(base));
  });

  it('distinguishes null from absent', () => {
    // "explicitly no value" and "not supplied" are different arguments to most APIs.
    expect(parameterDigest({ a: null })).not.toBe(parameterDigest({}));
  });

  it('distinguishes a number from its string form', () => {
    expect(parameterDigest({ n: 1 })).not.toBe(parameterDigest({ n: '1' }));
  });

  it('does NOT fold case — `--force` and `--Force` are different arguments', () => {
    expect(parameterDigest({ flag: '--force' })).not.toBe(parameterDigest({ flag: '--Force' }));
  });

  it('does not let a crafted key collide with a different structure', () => {
    // A naive `${key}=${value}` encoding collides here. The JSON-quoted form does not.
    expect(parameterDigest({ 'a=1&b': '2' })).not.toBe(parameterDigest({ a: '1', b: '2' }));
    expect(parameterDigest({ a: 'x', b: 'y' })).not.toBe(parameterDigest({ 'a": "x", "b': 'y' }));
  });
});

describe('values that cannot be canonicalised are refused, not coerced', () => {
  it('refuses NaN and Infinity rather than letting them become null', () => {
    expect(() => parameterDigest({ n: Number.NaN })).toThrow(NonCanonicalValueError);
    expect(() => parameterDigest({ n: Number.POSITIVE_INFINITY })).toThrow(NonCanonicalValueError);
  });

  it('refuses undefined inside an array, which would shift later arguments', () => {
    expect(() => parameterDigest({ args: [1, undefined, 3] as never })).toThrow(NonCanonicalValueError);
  });

  it('names the path so a caller can find the offending field', () => {
    try {
      parameterDigest({ outer: { inner: Number.NaN } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as NonCanonicalValueError).path).toBe('$.outer.inner');
    }
  });
});

describe('encoding shape', () => {
  it('produces the sha256:<64 hex> form the contracts expect', () => {
    expect(parameterDigest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable across runs', () => {
    expect(canonicalise({ b: [1, { d: 4, c: 3 }], a: 'x' })).toBe('{"a":"x","b":[1,{"c":3,"d":4}]}');
  });
});
