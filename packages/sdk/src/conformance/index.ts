/**
 * Shared conformance suites and the fake subjects they run against.
 *
 * `suites.ts` declares the contract a fake and its real implementation must both satisfy.
 * `subjects.ts` says which fake each suite is pointed at. Split so neither imports the
 * other's barrel — a cycle here would trip `no-circular` and, more to the point, would make
 * the dependency between "what the contract is" and "who is being tested" ambiguous.
 */
export * from './suites.js';
export * from './subjects.js';
