import { describe, expect, it } from 'vitest';
import { CONFORMANCE_SUITES, createFakeRegistry } from '@otondev/sdk';
import { FakeClock, deterministicIdFactory, runConformanceSuite } from '@otondev/testkit';
import type { ConformanceContext } from '@otondev/testkit';
import { CognitionGateway } from './gateway.js';
import { LocalAdapter, type ProviderAdapter } from './providers.js';
import { ResponseSchemaRegistry, schemaFrom } from './validation.js';
import type { ModelCandidate } from './routing.js';

/**
 * "Fake and implementation both pass the shared conformance suite" — S6 exit criterion.
 *
 * The shared suite that applies to cognition today is `controlHooks`, the W0-E emergency-stop
 * contract every service implements. There is no cognition-specific suite in `packages/sdk`;
 * that package is W0-owned, so one is requested rather than added here, and in the meantime
 * the parity that matters most is asserted directly: the fake and the gateway must answer the
 * emergency-stop hooks the same way, because S18 fans those out across every service and an
 * implementation that diverged from its fake would be discovered during an incident.
 */

function candidate(): ModelCandidate {
  return {
    provider: 'local',
    model: 'local-standard',
    model_version: '1',
    regions: [],
    retention: 'disabled',
    modalities: ['text'],
    max_context_tokens: 200_000,
    supports_structured_output: true,
    capabilities: [],
    eval_score: 0.9,
    quality_tier: 'standard',
    health: 'healthy',
    observed_latency_p95_ms: 100,
    usd_per_1k_input: 0.001,
    usd_per_1k_output: 0.002,
    local: true,
  };
}

function createGateway(context: ConformanceContext): CognitionGateway {
  const adapter = new LocalAdapter('local');
  return new CognitionGateway({
    runtime: { clock: context.clock, ids: context.ids },
    catalogue: [candidate()],
    adapters: new Map<string, ProviderAdapter>([['local', adapter]]),
    schemas: new ResponseSchemaRegistry().register(schemaFrom('PlanV2', () => ({ success: true, data: {} }))),
    contextSource: { fetch: async () => [] },
  });
}

describe('shared conformance', () => {
  it('the implementation passes the control-hooks suite', async () => {
    const report = await runConformanceSuite(CONFORMANCE_SUITES.controlHooks, {
      name: 'CognitionGateway',
      create: (context) => createGateway(context),
    });

    expect(report.failed, JSON.stringify(report.results.filter((r) => r.status !== 'pass'))).toBe(0);
    // `complete` is stricter than "nothing failed": a skipped case is an unanswered question.
    expect(report.complete).toBe(true);
  });

  it('the fake passes the same suite', async () => {
    const report = await runConformanceSuite(CONFORMANCE_SUITES.controlHooks, {
      name: 'FakeCognition',
      create: (context) =>
        createFakeRegistry({ clock: context.clock, ids: context.ids }).services.cognition,
    });

    expect(report.failed).toBe(0);
    expect(report.complete).toBe(true);
  });

  it('fake and implementation agree case by case, not just in total', async () => {
    // A total-only comparison passes when both are broken in different places. Comparing the
    // per-case verdicts is what makes this a parity check rather than a smoke test.
    const options = { startTime: '2026-08-09T12:00:00.000Z' };
    const implementation = await runConformanceSuite(
      CONFORMANCE_SUITES.controlHooks,
      { name: 'CognitionGateway', create: (context) => createGateway(context) },
      options,
    );
    const fake = await runConformanceSuite(
      CONFORMANCE_SUITES.controlHooks,
      {
        name: 'FakeCognition',
        create: (context) => createFakeRegistry({ clock: context.clock, ids: context.ids }).services.cognition,
      },
      options,
    );

    const verdicts = (results: typeof fake.results): Record<string, string> =>
      Object.fromEntries(results.map((result) => [result.name, result.status]));

    expect(verdicts(implementation.results)).toEqual(verdicts(fake.results));
  });

  it('both report the same service id', async () => {
    const clock = new FakeClock(Date.parse('2026-08-09T12:00:00Z'));
    const ids = deterministicIdFactory({ clock });
    // Built directly rather than through a fabricated ConformanceContext: `createGateway`
    // needs only the clock and ids, and inventing the rest of the context to satisfy a cast
    // would be asserting something about a type this test does not exercise.
    const gateway = new CognitionGateway({
      runtime: { clock, ids },
      catalogue: [candidate()],
      adapters: new Map<string, ProviderAdapter>([['local', new LocalAdapter('local')]]),
      schemas: new ResponseSchemaRegistry(),
      contextSource: { fetch: async () => [] },
    });
    const fake = createFakeRegistry({ clock, ids }).services.cognition;

    expect(gateway.serviceId).toBe(fake.serviceId);
    expect(gateway.serviceId).toBe('cognition');
  });
});
