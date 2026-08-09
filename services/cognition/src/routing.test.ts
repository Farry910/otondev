import { describe, expect, it } from 'vitest';
import { EXAMPLE_COGNITION_REQUEST, type CognitionRequest } from '@otondev/contracts';
import { DEFAULT_ROUTING_POLICY, selectRoute, type ModelCandidate, type RoutingPolicy } from './routing.js';

/**
 * Requests are built from the contract's own example so these tests break if the contract
 * changes shape, rather than passing against a hand-rolled object that has quietly drifted.
 */
function request(overrides: Partial<CognitionRequest> = {}): CognitionRequest {
  return {
    ...EXAMPLE_COGNITION_REQUEST,
    quality_tier: 'standard',
    latency_budget_ms: 30_000,
    cost_budget_usd: 5,
    required_capabilities: [],
    provider_constraints: { regions: [], retention: 'provider_default' },
    ...overrides,
  };
}

function candidate(overrides: Partial<ModelCandidate> = {}): ModelCandidate {
  return {
    provider: 'acme',
    model: 'acme-standard',
    model_version: '2026-01-01',
    regions: ['eu', 'us'],
    retention: 'zero_day',
    modalities: ['text'],
    max_context_tokens: 200_000,
    supports_structured_output: true,
    capabilities: [],
    eval_score: 0.8,
    quality_tier: 'standard',
    health: 'healthy',
    observed_latency_p95_ms: 4_000,
    usd_per_1k_input: 0.001,
    usd_per_1k_output: 0.002,
    local: false,
    ...overrides,
  };
}

describe('selectRoute', () => {
  it('picks a permitted, capable, healthy candidate and offers the rest as fallbacks', () => {
    const cheap = candidate({ provider: 'cheap', model: 'cheap-1', usd_per_1k_input: 0.0001, usd_per_1k_output: 0.0002 });
    const dear = candidate({ provider: 'dear', model: 'dear-1', usd_per_1k_input: 0.01, usd_per_1k_output: 0.02 });

    const outcome = selectRoute(request(), [dear, cheap]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.chosen.provider).toBe('cheap');
    expect(outcome.alternates.map((c) => c.provider)).toEqual(['dear']);
  });

  it('prefers an exact quality-tier match over a more capable one', () => {
    // Being handed 'high' when 'economy' was asked for is a budget surprise, not a favour.
    const economy = candidate({ provider: 'eco', quality_tier: 'economy', eval_score: 0.6 });
    const high = candidate({ provider: 'hi', quality_tier: 'high', eval_score: 0.95 });

    const outcome = selectRoute(request({ quality_tier: 'economy' }), [high, economy]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.chosen.provider).toBe('eco');
  });

  describe('fail-closed data policy', () => {
    it('refuses when the tenant allow-list excludes every candidate', () => {
      const outcome = selectRoute(
        request({ provider_constraints: { regions: [], retention: 'provider_default', allowed_providers: ['approved'] } }),
        [candidate({ provider: 'unapproved' })],
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('NO_PROVIDER_MEETS_DATA_POLICY');
    });

    it('never offers an excluded provider as a fallback', () => {
      // The exit criterion is that a forbidden provider "never silently falls back to a weaker
      // data policy". The dangerous shape is a fallback list assembled from the unfiltered
      // catalogue, so that is what is asserted here — not merely that `chosen` is permitted.
      const approved = candidate({ provider: 'approved', model: 'slow', observed_latency_p95_ms: 9_000 });
      const excluded = candidate({ provider: 'excluded', model: 'fast', observed_latency_p95_ms: 100 });

      const outcome = selectRoute(
        request({ provider_constraints: { regions: [], retention: 'provider_default', allowed_providers: ['approved'] } }),
        [approved, excluded],
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.chosen.provider).toBe('approved');
      const everyRoutable = [outcome.chosen, ...outcome.alternates].map((c) => c.provider);
      expect(everyRoutable).not.toContain('excluded');
    });

    it('drops a provider whose retention is weaker than the request demands', () => {
      const outcome = selectRoute(
        request({ provider_constraints: { regions: [], retention: 'disabled' } }),
        [candidate({ retention: 'provider_default' })],
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('NO_PROVIDER_MEETS_DATA_POLICY');
      expect(JSON.stringify(outcome.trace)).toContain('weaker than disabled');
    });

    it('keeps a provider whose retention is stricter than demanded', () => {
      const outcome = selectRoute(
        request({ provider_constraints: { regions: [], retention: 'zero_day' } }),
        [candidate({ retention: 'disabled' })],
      );

      expect(outcome.ok).toBe(true);
    });

    it('drops a provider with no region overlap', () => {
      const outcome = selectRoute(
        request({ provider_constraints: { regions: ['apac'], retention: 'provider_default' } }),
        [candidate({ regions: ['eu'] })],
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('NO_PROVIDER_MEETS_DATA_POLICY');
    });

    it('enforces local-only when policy forbids cloud', () => {
      const policy: RoutingPolicy = { ...DEFAULT_ROUTING_POLICY, forbidCloud: true };
      const outcome = selectRoute(request(), [candidate({ provider: 'cloud', local: false })], policy);

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('NO_PROVIDER_MEETS_DATA_POLICY');
      expect(outcome.reason).toContain('forbids cloud');
    });
  });

  it('refuses a prohibited purpose/risk combination before looking at any provider', () => {
    const policy: RoutingPolicy = {
      ...DEFAULT_ROUTING_POLICY,
      prohibited: [{ purpose: 'code', risk: EXAMPLE_COGNITION_REQUEST.risk }],
    };

    const outcome = selectRoute(request({ purpose: 'code' }), [candidate()], policy);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('PURPOSE_RISK_PROHIBITED');
    // Nothing about the catalogue should appear in the trace: the refusal is categorical.
    expect(outcome.trace).toHaveLength(1);
  });

  it('rejects a model that cannot produce structured output', () => {
    // "a prose response is a failed response" — such a model is wrong, not merely slower.
    const outcome = selectRoute(request(), [candidate({ supports_structured_output: false })]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(JSON.stringify(outcome.trace)).toContain('no structured-output support');
  });

  it('rejects a model below the measured eval floor for the requested tier', () => {
    const outcome = selectRoute(request({ quality_tier: 'high' }), [candidate({ eval_score: 0.7 })]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NO_PROVIDER_MEETS_EVAL_FLOOR');
  });

  it('rejects a model missing a required capability', () => {
    const outcome = selectRoute(
      request({ required_capabilities: ['tool_use'] }),
      [candidate({ capabilities: ['vision'] })],
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NO_PROVIDER_MEETS_CAPABILITY');
  });

  it('refuses when every candidate is over budget rather than overrunning it', () => {
    const outcome = selectRoute(
      request({ cost_budget_usd: 0.0001 }),
      [candidate({ usd_per_1k_input: 1, usd_per_1k_output: 1 })],
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NO_PROVIDER_WITHIN_BUDGET');
  });

  it('refuses when every capable provider is unavailable', () => {
    const outcome = selectRoute(request(), [candidate({ health: 'unavailable' })]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NO_PROVIDER_HEALTHY');
  });

  it('prefers a healthy provider over a degraded one', () => {
    const degraded = candidate({ provider: 'degraded', health: 'degraded', usd_per_1k_input: 0 });
    const healthy = candidate({ provider: 'healthy', health: 'healthy' });

    const outcome = selectRoute(request(), [degraded, healthy]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.chosen.provider).toBe('healthy');
  });

  it('records every elimination in the trace', () => {
    const outcome = selectRoute(request(), [candidate({ health: 'unavailable' }), candidate({ provider: 'ok' })]);

    expect(outcome.ok).toBe(true);
    const steps = outcome.trace.map((t) => t.step);
    expect(steps).toEqual([1, 2, 3, 4, 5]);
    expect(outcome.trace.at(-1)?.dropped[0]?.reason).toBe('provider unavailable');
  });

  it('is deterministic for identical candidates', () => {
    const a = candidate({ provider: 'a' });
    const b = candidate({ provider: 'b' });

    const first = selectRoute(request(), [a, b]);
    const second = selectRoute(request(), [b, a]);

    expect(first.ok && second.ok && first.chosen.provider === second.chosen.provider).toBe(true);
  });
});
