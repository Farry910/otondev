import { describe, expect, it } from 'vitest';
import { CONFORMANCE_SUITES, createFakeRegistry } from '@otondev/sdk';
import type { IngressClient } from '@otondev/sdk';
import type { ConformanceContext } from '@otondev/testkit';
import { formatConformanceReport, runConformanceSuite, runFakeParity } from '@otondev/testkit';
import { IngressService } from './ingress.js';
import { InMemoryDedupeLedger, InMemoryEventQueue, InMemoryEventStore, InMemoryPayloadStore, NullSecretResolver } from './store.js';
import { PresenceAuthenticator, TENANT } from './testing/harness.js';

/**
 * The shared suite, run against the real implementation.
 *
 * The real service is wired here with {@link PresenceAuthenticator} rather than the strict
 * default, and that is forced by the suite rather than chosen: `ingressSuite` sends
 * `x-signature: 'sig'` — a literal no HMAC can verify — on both its accepting cases, sends a
 * `x-signature` header for a *GitHub* delivery (whose real header is `x-hub-signature-256`),
 * and sends no timestamp at all. A correct verifier refuses all three.
 *
 * So the suite as written cannot distinguish a real verifier from a presence check. That is a
 * gap in the shared contract, not in this service, and it is raised as a contract request. It
 * is called out loudly here because the alternative — quietly relaxing the service so the
 * suite goes green — is exactly the failure the fake-parity machinery exists to prevent, just
 * pointed the other way. `ingress.test.ts` is where the real authenticator is exercised, and
 * `the default wiring is strict` asserts that production is not wired like this.
 */

function realIngress(context: ConformanceContext): IngressClient {
  const { services } = createFakeRegistry({ clock: context.clock, ids: context.ids });
  return new IngressService({
    clock: context.clock,
    ids: context.ids,
    audit: services.audit,
    ledger: new InMemoryDedupeLedger(),
    events: new InMemoryEventStore(),
    payloads: new InMemoryPayloadStore(),
    queue: new InMemoryEventQueue(),
    secrets: new NullSecretResolver(),
    authenticator: new PresenceAuthenticator(),
    config: {
      tenantId: TENANT,
      replayWindowSeconds: 300,
      maxBodyBytes: 256 * 1024,
      schemaMajor: 2,
      instance: 'ingress-conformance',
      version: '0.0.0',
    },
  });
}

function fakeIngress(context: ConformanceContext): IngressClient {
  return createFakeRegistry({ clock: context.clock, ids: context.ids }).services.ingress;
}

describe('shared conformance suite', () => {
  it('the real implementation passes it', async () => {
    const report = await runConformanceSuite(CONFORMANCE_SUITES.ingress, {
      name: 'IngressService',
      create: realIngress,
    });

    expect(formatConformanceReport(report)).toContain('0 failed');
    expect(report.complete).toBe(true);
  });

  it('the fake passes it too, and the two agree case by case', async () => {
    const report = await runFakeParity({
      suite: CONFORMANCE_SUITES.ingress,
      fake: { name: 'FakeIngress', create: fakeIngress },
      real: { name: 'IngressService', create: realIngress },
    });

    expect(report.divergences).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rows.length).toBe(CONFORMANCE_SUITES.ingress.cases.length);
  });
});

describe('the control-hook suite', () => {
  it('the real implementation satisfies the W0-E hooks', async () => {
    const report = await runConformanceSuite(CONFORMANCE_SUITES.controlHooks, {
      name: 'IngressService',
      create: realIngress,
    });

    expect(formatConformanceReport(report)).toContain('0 failed');
    expect(report.complete).toBe(true);
  });

  it('matches the fake on the hooks as well', async () => {
    const report = await runFakeParity({
      suite: CONFORMANCE_SUITES.controlHooks,
      fake: { name: 'FakeIngress', create: fakeIngress },
      real: { name: 'IngressService', create: realIngress },
    });

    expect(report.divergences).toEqual([]);
  });
});
