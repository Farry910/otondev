import { describe, expect, it } from 'vitest';
import { formatParityReport, runFakeParity } from '@otondev/testkit';
import type { SubjectUnderTest } from '@otondev/testkit';
import type { ConformanceContext, ConformanceSuite } from '@otondev/contracts';
import { createFakeRegistry } from '../fakes/index.js';
import type { FakeConnectorBroker } from '../fakes/control-plane.js';
import { CONFORMANCE_SUITES } from './index.js';
import { SERVICE_NAMES } from '../services/index.js';

/**
 * The fake-parity gate.
 *
 * Every shipped fake is run against the shared conformance suite for its interface. No real
 * implementation exists yet — this is Wave 0 — so the driver reports parity as UNPROVEN and
 * this test asserts the weaker but still essential half: **the fake passes its own suite**.
 *
 * That half is not a formality. Sixteen Wave-1 packages are about to be built against these
 * fakes. A fake that does not satisfy the contract it advertises does not merely fail later;
 * it teaches sixteen sessions the wrong behaviour first, and they discover it at integration.
 *
 * When a Wave-1 session lands its implementation it adds `real:` to the corresponding entry
 * and this same test starts comparing the two.
 */

function registry(context: ConformanceContext) {
  return createFakeRegistry({ clock: context.clock, ids: context.ids });
}

async function assertFakePasses<S>(suite: ConformanceSuite<S>, fake: SubjectUnderTest<S>): Promise<void> {
  const report = await runFakeParity({ suite, fake });
  if (!report.ok) {
    // The formatted report names the failing case and its reason, which is what a session
    // debugging its own fake actually needs.
    throw new Error(`\n${formatParityReport(report)}`);
  }
  expect(report.fake.complete).toBe(true);
}

describe('fake parity — control hooks apply to every service', () => {
  for (const name of SERVICE_NAMES) {
    it(`${name} satisfies the W0-E control hooks`, async () => {
      await assertFakePasses(CONFORMANCE_SUITES.controlHooks, {
        name: `fake:${name}`,
        create: (context) => registry(context).services[name],
      });
    });
  }
});

describe('fake parity — service suites', () => {
  it('ingress', async () => {
    await assertFakePasses(CONFORMANCE_SUITES.ingress, {
      name: 'FakeIngress',
      create: (context) => registry(context).services.ingress,
    });
  });

  it('workflow engine', async () => {
    await assertFakePasses(CONFORMANCE_SUITES.workflow, {
      name: 'FakeWorkflowEngine',
      create: (context) => registry(context).services.workflow,
    });
  });

  it('policy', async () => {
    await assertFakePasses(CONFORMANCE_SUITES.policy, {
      name: 'FakePolicy',
      capabilities: ['approvals'],
      create: (context) => registry(context).services.policy,
    });
  });

  it('capability broker', async () => {
    await assertFakePasses(CONFORMANCE_SUITES.broker, {
      name: 'FakeCapabilityBroker',
      create: (context) => registry(context).services.broker,
    });
  });

  it('connector broker', async () => {
    await assertFakePasses(CONFORMANCE_SUITES.connectors, {
      name: 'FakeConnectorBroker',
      create: (context) => {
        const { services } = registry(context);
        const connectors = services.connectors as FakeConnectorBroker;
        return {
          connectors,
          broker: services.broker,
          makeAmbiguous: (operation: string) => connectors.ambiguousOperations.add(operation),
          setRemoteState: (actionId: string, state: 'present' | 'absent' | 'indeterminate') =>
            connectors.remoteState.set(actionId, state),
        };
      },
    });
  });

  it('evidence', async () => {
    await assertFakePasses(CONFORMANCE_SUITES.evidence, {
      name: 'FakeEvidence',
      create: (context) => registry(context).services.evidence,
    });
  });

  it('verifier', async () => {
    await assertFakePasses(CONFORMANCE_SUITES.verifier, {
      name: 'FakeVerifier',
      create: (context) => registry(context).services.verifier,
    });
  });

  it('memory store — the suite S13 and S14 must both satisfy', async () => {
    await assertFakePasses(CONFORMANCE_SUITES.memoryStore, {
      name: 'FakeMemoryStore',
      create: (context) => registry(context).services.memoryStore,
    });
  });
});

describe('negative control — a green suite must mean something', () => {
  it('catches a fake that mints a NEW id for a duplicate delivery', async () => {
    // The whole value of the ingress suite rests on this one behaviour. If a subtly wrong
    // implementation still passes, the suite is decoration. So the suite is pointed at a
    // deliberately wrong subject and required to fail.
    const report = await runFakeParity({
      suite: CONFORMANCE_SUITES.ingress,
      fake: {
        name: 'BrokenIngress',
        create: (context) => {
          const ingress = registry(context).services.ingress;
          return {
            ...ingress,
            serviceId: ingress.serviceId,
            health: () => ingress.health(),
            deny: (r) => ingress.deny(r),
            quarantine: (r) => ingress.quarantine(r),
            revoke: (r) => ingress.revoke(r),
            getEvent: (id: string) => ingress.getEvent(id),
            lookupByDedupeKey: (key: string) => ingress.lookupByDedupeKey(key),
            // The bug: every delivery is treated as new.
            ingest: async (delivery: Parameters<typeof ingress.ingest>[0]) => {
              const outcome = await ingress.ingest(delivery);
              return outcome.status === 'duplicate'
                ? { status: 'accepted' as const, event_id: context.ids.next('event') }
                : outcome;
            },
          };
        },
      },
    });

    expect(report.ok).toBe(false);
    const failing = report.fake.results.filter((result) => result.status === 'fail');
    expect(failing.map((result) => result.name)).toContain(
      'a duplicate delivery returns the EXISTING canonical event id',
    );
  });

  it('catches a broker that skips the parameter-digest check', async () => {
    const report = await runFakeParity({
      suite: CONFORMANCE_SUITES.broker,
      fake: {
        name: 'PermissiveBroker',
        create: (context) => {
          const broker = registry(context).services.broker;
          return {
            ...broker,
            serviceId: broker.serviceId,
            health: () => broker.health(),
            deny: (r) => broker.deny(r),
            quarantine: (r) => broker.quarantine(r),
            revoke: (r) => broker.revoke(r),
            mint: (r: Parameters<typeof broker.mint>[0]) => broker.mint(r),
            consume: (id: string, call: Parameters<typeof broker.consume>[1]) => broker.consume(id, call),
            revokeCapability: (id: string, reason: string) => broker.revokeCapability(id, reason),
            currentRevocationEpoch: () => broker.currentRevocationEpoch(),
            // The bug: everything verifies.
            verify: async (capability: Parameters<typeof broker.verify>[0]) => ({
              valid: true,
              failed_checks: [],
              capability_id: capability.id,
              checked_at: context.clock.nowIso(),
            }),
          };
        },
      },
    });
    expect(report.ok).toBe(false);
  });
});

describe('the parity driver reports honestly about Wave 0', () => {
  it('says parity is unproven while no real implementation exists', async () => {
    const report = await runFakeParity({
      suite: CONFORMANCE_SUITES.verifier,
      fake: { name: 'FakeVerifier', create: (context) => registry(context).services.verifier },
    });
    expect(report.real).toBeNull();
    // The distinction between "verified equivalent" and "nothing to compare against" is the
    // whole value of the report. It must never be collapsed into a green tick.
    expect(formatParityReport(report)).toContain('Parity is UNPROVEN');
  });
});
