import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '@otondev/contracts';

/**
 * Golden files.
 *
 * Used for the things where "it changed" is the interesting question rather than "is it
 * equal to this literal I typed": an emitted JSON Schema, an assembled evidence bundle, a
 * policy decision's reason codes, an audit record's shape. Hand-written assertions on those
 * rot into a list nobody updates honestly.
 *
 * Two rules keep them useful rather than a rubber stamp:
 *
 *   1. Serialisation is canonical — keys sorted, two-space indent — so a diff is a real
 *      change and not a key-ordering artefact.
 *   2. Values are passed through the contracts redactor before being written. A golden file
 *      is committed, and a committed file with a captured token in it is a credential leak
 *      with a very long tail.
 */

export interface GoldenOptions {
  /** Set UPDATE_GOLDENS=1 to rewrite instead of compare. */
  update?: boolean;
  /** Directory for the file. Defaults to `__golden__` beside the test. */
  dir?: string;
}

/** Sorted-key JSON. Stable across runs and across Node versions. */
export function canonicalise(value: unknown): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)]),
      );
    }
    return node;
  };
  return `${JSON.stringify(sort(redact(value)), null, 2)}\n`;
}

export interface GoldenResult {
  path: string;
  match: boolean;
  expected: string;
  actual: string;
  created: boolean;
}

/**
 * Compare `value` against the golden file `name` next to `testFileUrl`.
 *
 * Returns a result rather than asserting, so the testkit needs no test-framework dependency
 * and the same harness works under vitest, node:test or a plain script. {@link assertGolden}
 * is the throwing convenience.
 */
export function compareGolden(
  testFileUrl: string,
  name: string,
  value: unknown,
  options: GoldenOptions = {},
): GoldenResult {
  const baseDir = options.dir ?? join(dirname(fileURLToPath(testFileUrl)), '__golden__');
  const path = join(baseDir, name.endsWith('.json') ? name : `${name}.json`);
  const actual = canonicalise(value);

  if (!existsSync(path)) {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(path, actual, 'utf8');
    return { path, match: true, expected: actual, actual, created: true };
  }

  const expected = readFileSync(path, 'utf8');
  if (options.update === true && expected !== actual) {
    writeFileSync(path, actual, 'utf8');
    return { path, match: true, expected: actual, actual, created: false };
  }
  return { path, match: expected === actual, expected, actual, created: false };
}

export function assertGolden(
  testFileUrl: string,
  name: string,
  value: unknown,
  options: GoldenOptions = {},
): void {
  const result = compareGolden(testFileUrl, name, value, options);
  if (result.match) return;
  throw new Error(
    [
      `Golden mismatch: ${result.path}`,
      '',
      firstDifference(result.expected, result.actual),
      '',
      'If the change is intended, re-run with UPDATE_GOLDENS=1.',
    ].join('\n'),
  );
}

/** The first differing line, with context. A full diff is noise when one field moved. */
function firstDifference(expected: string, actual: string): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  for (let i = 0; i < Math.max(e.length, a.length); i += 1) {
    if (e[i] !== a[i]) {
      return [`line ${i + 1}:`, `  expected: ${e[i] ?? '<end of file>'}`, `  actual:   ${a[i] ?? '<end of file>'}`].join('\n');
    }
  }
  return '  (files differ only in trailing whitespace)';
}
