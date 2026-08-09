/**
 * S1 — Event Ingress and Dedupe.
 *
 * `createIngressService` is the wiring most callers want, and it is the only place the
 * default security posture is decided. It wires {@link HmacAuthenticator}: a real signature
 * over the raw body bytes, plus a replay window that requires the timestamp a source promised
 * to send. A permissive authenticator exists only under `src/testing/`, and a test asserts
 * that the default is not it.
 */

import { HmacAuthenticator } from './authenticator.js';
import { DEFAULT_INGRESS_CONFIG, IngressService } from './ingress.js';
import type { IngressConfig, IngressDeps } from './ingress.js';
import {
  InMemoryDedupeLedger,
  InMemoryEventQueue,
  InMemoryEventStore,
  InMemoryPayloadStore,
  NullSecretResolver,
} from './store.js';

export { IngressService, DEFAULT_INGRESS_CONFIG } from './ingress.js';
export type { IngressConfig, IngressDeps, IngressMetadata } from './ingress.js';

export { HmacAuthenticator, parseTimestamp } from './authenticator.js';
export type { AuthOutcome, DeliveryAuthenticator, HmacAuthenticatorOptions } from './authenticator.js';

export { header, isExternalSource, sourceRule, verifySignature } from './sources.js';
export type { SignatureScheme, SignatureVerdict, SourceRule, SourceSystem } from './sources.js';

export {
  InMemoryDedupeLedger,
  InMemoryEventQueue,
  InMemoryEventStore,
  InMemoryPayloadStore,
  NullSecretResolver,
  StaticSecretResolver,
} from './store.js';
export type {
  DedupeLedger,
  EventQueue,
  EventStore,
  PayloadStore,
  Reservation,
  ReservationState,
  ReserveOutcome,
  SecretResolver,
} from './store.js';

export { SubjectVersionLedger, compareVersions } from './versions.js';
export type { SubjectVersionState, VersionOrder, VersionVerdict } from './versions.js';

export type IngressWiring = Partial<Omit<IngressDeps, 'clock' | 'ids' | 'audit' | 'config'>> & {
  config?: Partial<IngressConfig>;
};

/** The default wiring: in-memory stores, and a strict authenticator. */
export function createIngressService(
  base: Pick<IngressDeps, 'clock' | 'ids' | 'audit'> & { tenantId: string },
  wiring: IngressWiring = {},
): IngressService {
  const config: IngressConfig = {
    ...DEFAULT_INGRESS_CONFIG,
    tenantId: base.tenantId,
    ...wiring.config,
  };

  return new IngressService({
    clock: base.clock,
    ids: base.ids,
    audit: base.audit,
    ledger: wiring.ledger ?? new InMemoryDedupeLedger(),
    events: wiring.events ?? new InMemoryEventStore(),
    payloads: wiring.payloads ?? new InMemoryPayloadStore(),
    queue: wiring.queue ?? new InMemoryEventQueue(),
    secrets: wiring.secrets ?? new NullSecretResolver(),
    authenticator:
      wiring.authenticator ??
      new HmacAuthenticator({
        clock: base.clock,
        replayWindowSeconds: config.replayWindowSeconds,
        requireTimestamp: true,
      }),
    config,
  });
}
