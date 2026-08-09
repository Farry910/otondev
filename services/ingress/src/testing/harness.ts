/**
 * Test doubles for S1.
 *
 * The one that matters is {@link PresenceAuthenticator}. It lives here, under `src/testing/`,
 * and is exported from nowhere else — a permissive authenticator reachable from the package
 * entrypoint is the same defect as no authenticator at all.
 */

import { createHmac } from 'node:crypto';
import { createFakeRegistry } from '@otondev/sdk';
import type { ServiceRegistry, WebhookDelivery } from '@otondev/sdk';
import { FakeClock, deterministicIdFactory } from '@otondev/testkit';
import type { Clock, IdFactory } from '@otondev/contracts';
import type { AuthOutcome, DeliveryAuthenticator } from '../authenticator.js';
import { header } from '../sources.js';
import type { SourceRule } from '../sources.js';
import { IngressService } from '../ingress.js';
import type { IngressConfig } from '../ingress.js';
import { HmacAuthenticator } from '../authenticator.js';
import {
  InMemoryDedupeLedger,
  InMemoryEventQueue,
  InMemoryEventStore,
  InMemoryPayloadStore,
  StaticSecretResolver,
} from '../store.js';
import type { DedupeLedger, EventQueue, SecretResolver } from '../store.js';

export const TENANT = 'ten_01JQ0000000000000000000000';
export const SECRET = 'shhh-a-signing-secret';

/**
 * Accepts any delivery carrying a signature header, and ignores timestamps entirely.
 *
 * This mirrors `FakeIngress`, which is what the shared conformance suite is written against:
 * the suite sends `x-signature: 'sig'` — a literal that no HMAC can verify — and sends no
 * timestamp at all. So the real service can only pass the shared suite when wired with this.
 *
 * That is a gap in the suite, not in the service, and it is raised as a contract request:
 * as written, the ingress suite cannot tell a real verifier from a presence check.
 */
export class PresenceAuthenticator implements DeliveryAuthenticator {
  authenticate(rule: SourceRule, delivery: WebhookDelivery): AuthOutcome {
    if (rule.signature.kind === 'none') return { ok: true };
    const present =
      header(delivery.headers, 'x-signature') ?? header(delivery.headers, rule.signature.header);
    return present === undefined
      ? { ok: false, code: 'SIGNATURE_INVALID', detail: 'missing' }
      : { ok: true };
  }
}

/** Sign a body the way the strict authenticator expects, so a test can send a real signature. */
export function sign(body: Uint8Array, secret = SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

export function signVersioned(body: Uint8Array, timestamp: string, secret = SECRET): string {
  const material = Buffer.concat([Buffer.from(`v0:${timestamp}:`, 'utf8'), Buffer.from(body)]);
  return `v0=${createHmac('sha256', secret).update(material).digest('hex')}`;
}

export interface Harness {
  ingress: IngressService;
  clock: FakeClock;
  ids: IdFactory;
  services: ServiceRegistry;
  ledger: DedupeLedger;
  queue: InMemoryEventQueue;
}

export interface HarnessOptions {
  authenticator?: DeliveryAuthenticator;
  ledger?: DedupeLedger;
  queue?: EventQueue;
  secrets?: SecretResolver;
  config?: Partial<IngressConfig>;
  clock?: Clock;
  requireTimestamp?: boolean;
}

export function harness(options: HarnessOptions = {}): Harness {
  const clock = (options.clock as FakeClock | undefined) ?? new FakeClock('2026-07-30T08:00:00Z');
  const ids = deterministicIdFactory({ clock });
  const { services } = createFakeRegistry({ clock, ids });

  const ledger = options.ledger ?? new InMemoryDedupeLedger();
  const queue = (options.queue as InMemoryEventQueue | undefined) ?? new InMemoryEventQueue();
  const config: IngressConfig = {
    tenantId: TENANT,
    replayWindowSeconds: 300,
    maxBodyBytes: 1024,
    schemaMajor: 2,
    instance: 'ingress-test',
    version: '0.0.0',
    ...options.config,
  };

  const ingress = new IngressService({
    clock,
    ids,
    audit: services.audit,
    ledger,
    events: new InMemoryEventStore(),
    payloads: new InMemoryPayloadStore(),
    queue,
    secrets: options.secrets ?? new StaticSecretResolver({ jira: SECRET, github: SECRET, slack: SECRET, ci: SECRET }),
    authenticator:
      options.authenticator ??
      new HmacAuthenticator({
        clock,
        replayWindowSeconds: config.replayWindowSeconds,
        requireTimestamp: options.requireTimestamp ?? true,
      }),
    config,
  });

  return { ingress, clock, ids, services, ledger, queue };
}

/** A signed, in-window jira delivery. Tests override only the field they are about. */
export function jiraDelivery(
  clock: Clock,
  overrides: { body?: string; eventId?: string; headers?: Record<string, string>; version?: string } = {},
): WebhookDelivery {
  const body = new TextEncoder().encode(overrides.body ?? '{"ticket":"ENG-42"}');
  const timestamp = String(Math.floor(clock.nowMs() / 1000));
  return {
    system: 'jira',
    installation_id: 'jira_acme',
    body,
    headers: {
      'x-signature': sign(body),
      'x-timestamp': timestamp,
      'x-event-id': overrides.eventId ?? 'vendor_1',
      'x-principal': 'jira_cloud_app',
      'x-subject': 'ENG-42',
      'x-subject-version': overrides.version ?? '1',
      ...overrides.headers,
    },
    received_at: clock.nowIso(),
  };
}
