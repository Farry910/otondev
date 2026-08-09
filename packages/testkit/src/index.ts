/**
 * @otondev/testkit — the shared test harness.
 *
 * Depends on `@otondev/contracts` and nothing else, so every package can use it and none of
 * them can be reached from it (`testkit-is-implementation-free` boundary rule). Importing it
 * from a production entrypoint is a build failure, not a code-review note.
 */

export * from './clock.js';
export * from './ids.js';
export * from './faults.js';
export * from './golden.js';
export * from './conformance.js';
export * from './fake-parity.js';
