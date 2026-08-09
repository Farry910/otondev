import { createHash } from 'node:crypto';
import type { Clock, Component, DataClass, Envelope } from '@otondev/contracts';
import type { RuntimeContext } from '../runtime.js';

/** `now + seconds`, in the RFC3339 UTC form every `*_at` field expects. */
export function plusSeconds(clock: Clock, seconds: number): string {
  return new Date(clock.nowMs() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** SHA-256 of a value, as 64 lowercase hex characters. */
export function hexDigestOf(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** SHA-256 in the `sha256:<hex>` form the contracts use for digests. */
export function digestOf(value: string | Uint8Array): string {
  return `sha256:${hexDigestOf(value)}`;
}

/**
 * Build the common envelope (contracts §1) for a fake-produced record.
 *
 * Fakes emit records that satisfy the *real* schemas. A fake that emitted a loosely-shaped
 * object would let a downstream session write a test that passes against the fake and fails
 * against every real peer — which is precisely the rot the fake-parity driver exists to
 * catch, arriving one layer earlier than it needs to.
 */
export function envelopeFor<S extends string>(
  runtime: RuntimeContext,
  // Generic over the literal so a spread of the result keeps `schema: 'agentdev.event.v2'`
  // rather than widening to `string` and failing to satisfy the record's own type.
  schema: S,
  id: string,
  tenantId: string,
  service: Component,
  options: { correlationId?: string; dataClasses?: DataClass[]; causationId?: string } = {},
): Omit<Envelope, 'schema'> & { schema: S } {
  const base = {
    schema,
    id,
    tenant_id: tenantId,
    correlation_id: options.correlationId ?? runtime.ids.next('correlation'),
    created_at: runtime.clock.nowIso(),
    producer: { service, instance: `${service}-fake`, version: '0.0.0' },
    data_classes: options.dataClasses ?? (['internal'] as DataClass[]),
    integrity: { alg: 'sha256' as const, digest: hexDigestOf(`${schema}:${id}`) },
  };
  return options.causationId === undefined ? base : { ...base, causation_id: options.causationId };
}
