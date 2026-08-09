import type { CognitionRequest } from '@otondev/contracts';

/**
 * The routing algorithm, cognition-router.md "Routing algorithm" steps 1–5.
 *
 * Steps 6–9 (reserve budget, call, validate, return) live outside this module because they
 * have effects; everything here is a pure function of the request, the catalogue, and policy.
 * That split is deliberate: route selection is the part a prompt-injection attack would most
 * like to influence, and a pure function with a recorded trace is the part that can be argued
 * about in a test rather than in an incident.
 *
 * **Fail-closed is structural, not a check at the end.** Constraint filtering (step 2) happens
 * once, and every later step — including fallback selection — draws only from its output. There
 * is no code path that can reach a candidate the tenant's data policy excluded, because the
 * excluded candidates are not in the set any longer. The alternative shape, filtering late or
 * re-widening on failure, is how "never silently falls back to a weaker data policy" gets
 * violated by an ordinary-looking retry.
 */

export type QualityTier = 'economy' | 'standard' | 'high';
export type ProviderHealth = 'healthy' | 'degraded' | 'unavailable';
export type Retention = 'disabled' | 'zero_day' | 'provider_default';

/** One routable model. The catalogue is supplied by configuration, not discovered at runtime. */
export interface ModelCandidate {
  readonly provider: string;
  readonly model: string;
  readonly model_version: string;
  /** Regions the provider will process in. Empty means the provider makes no commitment. */
  readonly regions: readonly string[];
  readonly retention: Retention;
  readonly modalities: readonly string[];
  readonly max_context_tokens: number;
  readonly supports_structured_output: boolean;
  readonly capabilities: readonly string[];
  /** Measured, from the S19 harness. Not a vendor claim. */
  readonly eval_score: number;
  readonly quality_tier: QualityTier;
  readonly health: ProviderHealth;
  readonly observed_latency_p95_ms: number;
  readonly usd_per_1k_input: number;
  readonly usd_per_1k_output: number;
  /** Runs inside the trust boundary — no egress. */
  readonly local: boolean;
}

export interface RoutingPolicy {
  /** Purpose/risk pairs that may never be routed at all. Owned by S4, faked here. */
  readonly prohibited: ReadonlyArray<{ purpose: CognitionRequest['purpose']; risk: CognitionRequest['risk'] }>;
  /** Minimum measured eval score per quality tier. A model below its floor is not a candidate. */
  readonly evalFloor: Readonly<Record<QualityTier, number>>;
  /** When true, cloud providers are excluded outright regardless of other constraints. */
  readonly forbidCloud: boolean;
  /** Tokens assumed for cost estimation when the caller gives no better figure. */
  readonly assumedInputTokens: number;
  readonly assumedOutputTokens: number;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  prohibited: [],
  evalFloor: { economy: 0.5, standard: 0.65, high: 0.8 },
  forbidCloud: false,
  assumedInputTokens: 8_000,
  assumedOutputTokens: 1_000,
};

export type RouteRefusalCode =
  | 'PURPOSE_RISK_PROHIBITED'
  | 'NO_PROVIDER_MEETS_DATA_POLICY'
  | 'NO_PROVIDER_MEETS_CAPABILITY'
  | 'NO_PROVIDER_MEETS_EVAL_FLOOR'
  | 'NO_PROVIDER_WITHIN_BUDGET'
  | 'NO_PROVIDER_HEALTHY';

/** Why each candidate was dropped, kept for the audit record and for arguing about in tests. */
export interface RouteTrace {
  readonly step: number;
  readonly name: string;
  readonly remaining: number;
  readonly dropped: ReadonlyArray<{ model: string; reason: string }>;
}

export type RouteOutcome =
  | {
      readonly ok: true;
      readonly chosen: ModelCandidate;
      /**
       * Ordered fallbacks. Drawn from the same constrained set as {@link chosen}, so choosing
       * one can only ever lower quality or raise cost — never weaken the data policy.
       */
      readonly alternates: readonly ModelCandidate[];
      readonly trace: readonly RouteTrace[];
    }
  | {
      readonly ok: false;
      readonly code: RouteRefusalCode;
      readonly reason: string;
      readonly trace: readonly RouteTrace[];
    };

function estimateCostUsd(candidate: ModelCandidate, policy: RoutingPolicy): number {
  return (
    (policy.assumedInputTokens / 1000) * candidate.usd_per_1k_input +
    (policy.assumedOutputTokens / 1000) * candidate.usd_per_1k_output
  );
}

export function selectRoute(
  request: CognitionRequest,
  catalogue: readonly ModelCandidate[],
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): RouteOutcome {
  const trace: RouteTrace[] = [];

  const record = (
    step: number,
    name: string,
    kept: readonly ModelCandidate[],
    dropped: ReadonlyArray<{ model: string; reason: string }>,
  ): void => {
    trace.push({ step, name, remaining: kept.length, dropped });
  };

  // ---- step 1: reject prohibited purpose/risk combinations -------------------------------
  const prohibited = policy.prohibited.some(
    (rule) => rule.purpose === request.purpose && rule.risk === request.risk,
  );
  if (prohibited) {
    record(1, 'purpose/risk', [], [{ model: '*', reason: `${request.purpose}@${request.risk} is prohibited` }]);
    return {
      ok: false,
      code: 'PURPOSE_RISK_PROHIBITED',
      reason: `purpose '${request.purpose}' at risk '${request.risk}' may not be routed`,
      trace,
    };
  }
  record(1, 'purpose/risk', catalogue, []);

  // ---- step 2: data residency, retention, tenant allow-list ------------------------------
  // Everything downstream draws from `permitted`. This is the fail-closed boundary.
  const constraints = request.provider_constraints;
  const dropped2: Array<{ model: string; reason: string }> = [];
  const permitted = catalogue.filter((candidate) => {
    const id = `${candidate.provider}/${candidate.model}`;

    if (constraints.allowed_providers && !constraints.allowed_providers.includes(candidate.provider)) {
      dropped2.push({ model: id, reason: 'provider not in the tenant allow-list' });
      return false;
    }

    // An empty region list means "no constraint expressed", which the contract is explicit is
    // not the same as "anywhere is fine" — but the constraint that matters is the request's.
    if (constraints.regions.length > 0) {
      const overlaps = candidate.regions.some((region) => constraints.regions.includes(region));
      if (!overlaps) {
        dropped2.push({ model: id, reason: `no region overlap (offers ${candidate.regions.join(',') || 'none'})` });
        return false;
      }
    }

    // Retention is ordered: disabled is stricter than zero_day, which is stricter than default.
    // A candidate satisfies the request only if it is at least as strict as what was asked for.
    const strictness: Record<Retention, number> = { disabled: 2, zero_day: 1, provider_default: 0 };
    if (strictness[candidate.retention] < strictness[constraints.retention]) {
      dropped2.push({ model: id, reason: `retention ${candidate.retention} is weaker than ${constraints.retention}` });
      return false;
    }

    return true;
  });
  record(2, 'data policy', permitted, dropped2);

  if (permitted.length === 0) {
    return {
      ok: false,
      code: 'NO_PROVIDER_MEETS_DATA_POLICY',
      reason: 'no provider satisfies the tenant allow-list, residency, and retention constraints',
      trace,
    };
  }

  // ---- step 3: prefer local processing ---------------------------------------------------
  // A preference, except when policy forbids cloud, where it becomes a filter.
  const localOnly = permitted.filter((candidate) => candidate.local);
  let pool = permitted;
  if (policy.forbidCloud) {
    const dropped3 = permitted.filter((c) => !c.local).map((c) => ({
      model: `${c.provider}/${c.model}`,
      reason: 'policy forbids cloud processing',
    }));
    pool = localOnly;
    record(3, 'local processing (enforced)', pool, dropped3);
    if (pool.length === 0) {
      return {
        ok: false,
        code: 'NO_PROVIDER_MEETS_DATA_POLICY',
        reason: 'policy forbids cloud processing and no local model satisfies the request',
        trace,
      };
    }
  } else {
    record(3, 'local processing (preferred)', pool, []);
  }

  // ---- step 4: capability, schema support, context, eval floor ---------------------------
  const dropped4: Array<{ model: string; reason: string }> = [];
  const capable = pool.filter((candidate) => {
    const id = `${candidate.provider}/${candidate.model}`;

    // Structured output is mandatory per the request contract: "a prose response is a failed
    // response". A model that cannot produce it is not a slower option, it is a wrong one.
    if (!candidate.supports_structured_output) {
      dropped4.push({ model: id, reason: 'no structured-output support' });
      return false;
    }

    const missing = request.required_capabilities.filter((cap) => !candidate.capabilities.includes(cap));
    if (missing.length > 0) {
      dropped4.push({ model: id, reason: `missing capabilities: ${missing.join(',')}` });
      return false;
    }

    const floor = policy.evalFloor[request.quality_tier];
    if (candidate.eval_score < floor) {
      dropped4.push({ model: id, reason: `eval ${candidate.eval_score} below ${request.quality_tier} floor ${floor}` });
      return false;
    }

    return true;
  });
  record(4, 'capability and eval floor', capable, dropped4);

  if (capable.length === 0) {
    const anyCapability = dropped4.some((d) => d.reason.startsWith('missing capabilities'));
    return {
      ok: false,
      code: anyCapability ? 'NO_PROVIDER_MEETS_CAPABILITY' : 'NO_PROVIDER_MEETS_EVAL_FLOOR',
      reason: 'no permitted provider meets the required capabilities, schema support, and eval floor',
      trace,
    };
  }

  // ---- step 5: rank by quality tier, health, latency, cost -------------------------------
  const dropped5: Array<{ model: string; reason: string }> = [];
  const affordable = capable.filter((candidate) => {
    const id = `${candidate.provider}/${candidate.model}`;
    if (candidate.health === 'unavailable') {
      dropped5.push({ model: id, reason: 'provider unavailable' });
      return false;
    }
    const cost = estimateCostUsd(candidate, policy);
    if (cost > request.cost_budget_usd) {
      dropped5.push({ model: id, reason: `estimated $${cost.toFixed(4)} exceeds budget $${request.cost_budget_usd}` });
      return false;
    }
    if (candidate.observed_latency_p95_ms > request.latency_budget_ms) {
      dropped5.push({
        model: id,
        reason: `p95 ${candidate.observed_latency_p95_ms} ms exceeds budget ${request.latency_budget_ms} ms`,
      });
      return false;
    }
    return true;
  });
  record(5, 'health, cost, latency', affordable, dropped5);

  if (affordable.length === 0) {
    const onlyHealth = dropped5.every((d) => d.reason === 'provider unavailable');
    return {
      ok: false,
      code: onlyHealth ? 'NO_PROVIDER_HEALTHY' : 'NO_PROVIDER_WITHIN_BUDGET',
      reason: 'every capable provider is unavailable, too slow, or too expensive for this request',
      trace,
    };
  }

  const tierRank: Record<QualityTier, number> = { high: 2, standard: 1, economy: 0 };
  const ranked = [...affordable].sort((a, b) => {
    // Exact tier match first: asking for 'economy' and being handed 'high' is a budget
    // surprise, not a favour.
    const aExact = a.quality_tier === request.quality_tier ? 0 : 1;
    const bExact = b.quality_tier === request.quality_tier ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    const healthRank = { healthy: 0, degraded: 1, unavailable: 2 } as const;
    if (healthRank[a.health] !== healthRank[b.health]) return healthRank[a.health] - healthRank[b.health];

    if (a.eval_score !== b.eval_score) return b.eval_score - a.eval_score;

    const costDelta = estimateCostUsd(a, policy) - estimateCostUsd(b, policy);
    if (Math.abs(costDelta) > 1e-9) return costDelta;

    if (a.observed_latency_p95_ms !== b.observed_latency_p95_ms) {
      return a.observed_latency_p95_ms - b.observed_latency_p95_ms;
    }
    if (tierRank[a.quality_tier] !== tierRank[b.quality_tier]) {
      return tierRank[b.quality_tier] - tierRank[a.quality_tier];
    }
    return `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`);
  });

  const [chosen, ...alternates] = ranked;
  return { ok: true, chosen: chosen!, alternates, trace };
}
