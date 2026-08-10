import { describe, expect, it } from 'vitest';
import { CONFORMANCE_SUITES, createFakeRegistry } from '@otondev/sdk';
import type { PolicyClient } from '@otondev/sdk';
import { formatParityReport, runFakeParity } from '@otondev/testkit';
import type { ConformanceContext } from '@otondev/contracts';
import { PolicyService } from '../src/service.js';
import { keypair, testBundleBody, KEY_ID, TENANT } from './helpers.js';
import { signBundle } from '../src/bundle.js';

/**
 * The exit criterion: "fake and implementation both pass the shared conformance suite."
 *
 * `CONFORMANCE_SUITES.policy` is the suite W0 published next to the `PolicyClient` interface.
 * It is imported, not restated — a suite written twice is two suites, and they diverge in a
 * week. The fake-parity driver runs the identical cases against the SDK's in-memory fake and
 * against this service and compares them case by case.
 *
 * The comparison is the point. Either side passing alone would be much weaker: a fake that
 * promises behaviour the implementation does not deliver is exactly what every Wave-1 session
 * building against `PolicyClient` would be misled by.
 */

function realPolicy(context: ConformanceContext): PolicyClient {
  const { publicKeyPem, privateKeyPem } = keypair();
  return new PolicyService({
    tenantId: TENANT,
    clock: context.clock,
    ids: context.ids,
    bundle: signBundle(testBundleBody(), privateKeyPem, KEY_ID),
    trustedKeys: new Map([[KEY_ID, publicKeyPem]]),
    audit: createFakeRegistry({ clock: context.clock, ids: context.ids }).services.audit,
  });
}

describe('shared conformance suite', () => {
  it('the real implementation and the fake agree, case for case', async () => {
    const report = await runFakeParity({
      suite: CONFORMANCE_SUITES.policy,
      fake: {
        name: 'FakePolicy',
        capabilities: ['approvals'],
        create: (context) => createFakeRegistry({ clock: context.clock, ids: context.ids }).services.policy,
      },
      real: {
        name: 'PolicyService',
        capabilities: ['approvals'],
        create: realPolicy,
      },
    });

    if (!report.ok) throw new Error(`\n${formatParityReport(report)}`);

    expect(report.divergences).toEqual([]);
    expect(report.real?.complete).toBe(true);
    expect(report.fake.complete).toBe(true);
  });

  it('the implementation also satisfies the W0-E control hooks every service must', async () => {
    const report = await runFakeParity({
      suite: CONFORMANCE_SUITES.controlHooks,
      fake: {
        name: 'FakePolicy',
        create: (context) => createFakeRegistry({ clock: context.clock, ids: context.ids }).services.policy,
      },
      real: { name: 'PolicyService', create: realPolicy },
    });

    if (!report.ok) throw new Error(`\n${formatParityReport(report)}`);
    expect(report.divergences).toEqual([]);
  });
});

describe('negative control — the suite can tell a broken policy service apart', () => {
  it('fails a service that stops checking one bound field', async () => {
    // Without this, "the suite passed" would only mean the suite ran. The mutation is the
    // smallest realistic regression: one field quietly dropped from the binding check.
    const report = await runFakeParity({
      suite: CONFORMANCE_SUITES.policy,
      fake: {
        name: 'PermissivePolicy',
        capabilities: ['approvals'],
        create: (context) => {
          const service = realPolicy(context);
          return {
            ...service,
            serviceId: service.serviceId,
            health: () => service.health(),
            deny: (r) => service.deny(r),
            quarantine: (r) => service.quarantine(r),
            revoke: (r) => service.revoke(r),
            evaluate: (q) => service.evaluate(q),
            bundleRef: () => service.bundleRef(),
            createApproval: (i) => service.createApproval(i),
            getApproval: (id: string) => service.getApproval(id),
            // The bug: resource is no longer part of the binding.
            consumeApproval: (id: string, binding) =>
              service.getApproval(id).then((approval) =>
                service.consumeApproval(id, { ...binding, resource: approval?.resource ?? binding.resource }),
              ),
          } as PolicyClient;
        },
      },
    });

    expect(report.ok).toBe(false);
    expect(report.fake.results.filter((r) => r.status === 'fail').map((r) => r.name)).toContain(
      'editing ANY bound field invalidates an approval',
    );
  });
});
