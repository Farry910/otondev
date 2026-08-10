import { createHash } from 'node:crypto';
import type { Clock, Component, DataClass, Envelope, IdFactory } from '@otondev/contracts';

/**
 * Envelope construction for records this service produces.
 *
 * Deliberately local rather than imported from the SDK's fake support. The helper there
 * exists to let *fakes* emit schema-valid records; a real service reaching into fake
 * scaffolding would make the dependency graph say something untrue about what this package
 * is, and `packages/sdk` is frozen while this file is mine to change.
 *
 * It is fifteen lines. The duplication is cheaper than the coupling.
 */
export interface EnvelopeContext {
  clock: Clock;
  ids: IdFactory;
  service: Component;
  instance: string;
  version: string;
}

export function makeEnvelope<S extends string>(
  context: EnvelopeContext,
  schema: S,
  id: string,
  tenantId: string,
  options: {
    agentId?: string;
    workflowId?: string;
    correlationId?: string;
    causationId?: string;
    dataClasses?: readonly DataClass[];
  } = {},
): Omit<Envelope, 'schema'> & { schema: S } {
  const base = {
    schema,
    id,
    tenant_id: tenantId,
    correlation_id: options.correlationId ?? context.ids.next('correlation'),
    created_at: context.clock.nowIso(),
    producer: {
      service: context.service,
      instance: context.instance,
      version: context.version,
    },
    data_classes: [...(options.dataClasses ?? ['internal'])] as DataClass[],
    integrity: {
      alg: 'sha256' as const,
      digest: createHash('sha256').update(`${schema}:${id}`).digest('hex'),
    },
  };

  return {
    ...base,
    ...(options.agentId === undefined ? {} : { agent_id: options.agentId }),
    ...(options.workflowId === undefined ? {} : { workflow_id: options.workflowId }),
    ...(options.causationId === undefined ? {} : { causation_id: options.causationId }),
  };
}
