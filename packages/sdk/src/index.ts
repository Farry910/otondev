/**
 * @otondev/sdk — the seam.
 *
 * A typed client interface for every S1-S20 service, a minimal in-memory fake for each, the
 * W0-E emergency-stop hooks, and the structured-logging and OpenTelemetry bootstrap.
 *
 * This package holds no implementation of any service and, by boundary rule, cannot import
 * one. That is what lets twenty sessions build at once: each consumes its peers through the
 * interfaces here, backed by the fakes here, and never reads another service's source.
 */

export * from './runtime.js';
export * from './hooks.js';
export * from './services/index.js';
export * from './fakes/index.js';
export * from './observability/index.js';
export * from './conformance/index.js';
