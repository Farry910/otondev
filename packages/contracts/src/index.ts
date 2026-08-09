/**
 * @otondev/contracts — the normative surface.
 *
 * Every package reads this one and this one reads no package (enforced by the
 * `contracts-is-a-leaf` boundary rule). After Wave 0 it is frozen: additive changes go
 * through the contract owner as a standalone change, renames and removals are scheduled with
 * a version bump (implementation-plan §6 rule 3). If you need something it cannot express,
 * raise a contract request and keep building under a stated assumption — see
 * CONTRACT-REQUESTS.md.
 */

export * from './ids.js';
export * from './primitives.js';
export * from './redaction.js';
export * from './versioning.js';
export * from './envelope.js';
export * from './errors.js';
export * from './workflow-states.js';

// Record schemas, in contracts-and-data.md order.
export * from './event.js'; // §2
export {
  WORKFLOW_TYPES,
  WorkflowLease,
  WorkflowBudget,
  WorkflowRecord,
  WorkflowTransition,
} from './workflow.js'; // §3
export * from './plan.js'; // §4
export * from './policy.js'; // §5
export * from './capability.js'; // §6
export * from './action.js'; // §7
export * from './cognition.js'; // §8
export * from './memory.js'; // §9
export * from './evidence.js'; // §10
export * from './audit.js'; // S8

export * from './registry.js';
export * from './json-schema.js';

/**
 * The conformance-suite *shape*. The runner and the fake-parity driver live in
 * `@otondev/testkit`; suites themselves are declared next to the interfaces they describe,
 * in `@otondev/sdk`. See the module comment for why the type lives here.
 */
export * from './conformance.js';

/**
 * Known-good records. Not test-only: a Wave-1 session builds its first test around these,
 * and the contract test parses each one to prove every schema is satisfiable at all.
 */
export * from './examples.js';
