/**
 * S2 — Workflow Engine.
 *
 * The public surface is the engine, the storage port, and the two things a deployment has to
 * choose: which store adapter and which containment port. Nothing else is exported, because
 * a peer consumes this service through `WorkflowEngineClient` in `@otondev/sdk` and should
 * never need a type from here.
 */
export { WorkflowEngine } from './engine.js';
export type { CompensationHook, WorkflowEngineOptions } from './engine.js';

export { MemoryWorkflowStore } from './memory-store.js';
export { SqlWorkflowStore } from './sql-store.js';
export type { SqlExecutor } from './sql-store.js';
export type { CommitOutcome, LeaseMutator, Mutator, WorkflowStore } from './store.js';

export { brokerContainment, noContainment } from './containment.js';
export type { ContainmentOutcome, ContainmentPort, ContainmentRequest } from './containment.js';

export { DEFAULT_BACKOFF, delayForAttempt, nextWakeupAt } from './backoff.js';
export type { BackoffPolicy } from './backoff.js';
