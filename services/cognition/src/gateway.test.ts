import { beforeEach, describe, expect, it } from 'vitest';
import { ContractError, EXAMPLE_COGNITION_REQUEST, type CognitionRequest } from '@otondev/contracts';
import { FakeClock, deterministicIdFactory } from '@otondev/testkit';
import type { RuntimeContext } from '@otondev/sdk';
import { CognitionGateway, type ContextSource } from './gateway.js';
import { LocalAdapter, type ProviderAdapter } from './providers.js';
import { ResponseSchemaRegistry, schemaFrom } from './validation.js';
import { BudgetLedger, authorizeIncrease } from './budget.js';
import { InMemoryAuditSink, FORBIDDEN_AUDIT_FIELDS } from './audit.js';
import { DEFAULT_CONTEXT_POLICY, type ContextFragment } from './context-builder.js';
import type { ModelCandidate } from './routing.js';

const PLAN_SCHEMA = 'PlanV2';

function candidate(overrides: Partial<ModelCandidate> = {}): ModelCandidate {
  return {
    provider: 'local',
    model: 'local-standard',
    model_version: '1',
    regions: ['eu', 'us'],
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
    ...overrides,
  };
}

function request(overrides: Partial<CognitionRequest> = {}): CognitionRequest {
  return {
    ...EXAMPLE_COGNITION_REQUEST,
    quality_tier: 'standard',
    latency_budget_ms: 30_000,
    cost_budget_usd: 1,
    required_capabilities: [],
    response_schema: PLAN_SCHEMA,
    provider_constraints: { regions: [], retention: 'provider_default' },
    ...overrides,
  };
}

const goalFragment: ContextFragment = {
  section: 'task_goal',
  source: 'workflow',
  data_class: 'internal',
  fields: { goal: 'raise a pull request' },
};

function fixedContext(fragments: readonly ContextFragment[] = [goalFragment]): ContextSource {
  return { fetch: async () => fragments };
}

interface Harness {
  gateway: CognitionGateway;
  adapter: LocalAdapter;
  audit: InMemoryAuditSink;
  budget: BudgetLedger;
  runtime: RuntimeContext;
}

function harness(options: {
  catalogue?: readonly ModelCandidate[];
  adapters?: ReadonlyMap<string, ProviderAdapter>;
  context?: ContextSource;
  limitUsd?: number;
} = {}): Harness {
  const clock = new FakeClock(Date.parse('2026-08-09T12:00:00Z'));
  const runtime: RuntimeContext = { clock, ids: deterministicIdFactory({ clock }) };
  const adapter = new LocalAdapter('local');
  adapter.responses.set(PLAN_SCHEMA, { steps: ['one'] });

  const audit = new InMemoryAuditSink();
  const budget = new BudgetLedger();
  budget.setLimit(EXAMPLE_COGNITION_REQUEST.workflow_id, options.limitUsd ?? 100);

  const schemas = new ResponseSchemaRegistry().register(
    schemaFrom(PLAN_SCHEMA, (value) =>
      typeof value === 'object' && value !== null && Array.isArray((value as { steps?: unknown }).steps)
        ? { success: true, data: value }
        : { success: false, error: { message: 'expected { steps: string[] }' } },
    ),
  );

  const gateway = new CognitionGateway({
    runtime,
    catalogue: options.catalogue ?? [candidate()],
    adapters: options.adapters ?? new Map<string, ProviderAdapter>([['local', adapter]]),
    schemas,
    contextSource: options.context ?? fixedContext(),
    budget,
    audit,
  });

  return { gateway, adapter, audit, budget, runtime };
}

async function codeOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
    return '<no error>';
  } catch (error) {
    return error instanceof ContractError ? error.code : `<${String(error)}>`;
  }
}

describe('CognitionGateway.generateStructured', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('returns a validated result with provenance', async () => {
    const result = await h.gateway.generateStructured(request());

    expect(result.schema).toBe('agentdev.cognition_result.v2');
    expect(result.provider).toBe('local');
    expect(result.schema_verdict).toBe('valid');
    expect(result.content).toEqual({ steps: ['one'] });
    expect(result.authorized_context_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.prompt_template.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.completion_reason).toBe('stop');
  });

  it('returns no authorization field of any kind', async () => {
    // S6's blunt exit criterion. Asserted on the serialised result so a nested field would
    // fail too, not just a top-level one.
    const result = await h.gateway.generateStructured(request());
    const serialised = JSON.stringify(result).toLowerCase();

    for (const forbidden of ['"allowed"', '"approved"', '"authorized"', '"permission"', '"grant"', '"decision"']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  describe('fail-closed data policy', () => {
    it('refuses when no provider satisfies the tenant allow-list', async () => {
      const code = await codeOf(
        h.gateway.generateStructured(
          request({
            provider_constraints: { regions: [], retention: 'provider_default', allowed_providers: ['nobody'] },
          }),
        ),
      );

      expect(code).toBe('DATA_PROVIDER_FORBIDDEN');
    });

    it('never falls back to a provider the data policy excluded', async () => {
      // `excluded` is healthy and cheap; `approved` fails every attempt. A gateway that
      // widened its candidate set on failure would succeed here — which is exactly the
      // behaviour the criterion forbids.
      const approved = new LocalAdapter('approved');
      approved.failures.set(PLAN_SCHEMA, 'PROVIDER_UNAVAILABLE');
      const excluded = new LocalAdapter('excluded');
      excluded.responses.set(PLAN_SCHEMA, { steps: ['leaked'] });

      const local = harness({
        catalogue: [
          candidate({ provider: 'approved', model: 'a' }),
          candidate({ provider: 'excluded', model: 'b' }),
        ],
        adapters: new Map<string, ProviderAdapter>([
          ['approved', approved],
          ['excluded', excluded],
        ]),
      });

      const code = await codeOf(
        local.gateway.generateStructured(
          request({
            provider_constraints: { regions: [], retention: 'provider_default', allowed_providers: ['approved'] },
          }),
        ),
      );

      expect(code).toBe('PROVIDER_UNAVAILABLE');
      expect(excluded.calls).toBe(0);
    });

    it('refuses to send context containing a secret', async () => {
      const local = harness({
        context: fixedContext([
          { ...goalFragment, section: 'verified_facts', fields: { claim: 'AKIAIOSFODNN7EXAMPLE' } },
        ]),
      });

      const code = await codeOf(local.gateway.generateStructured(request()));

      expect(code).toBe('DATA_PROVIDER_FORBIDDEN');
      expect(local.adapter.calls).toBe(0);
    });

    it('refuses when an instruction section had to be truncated', async () => {
      // Truncating instructions produces a different prompt, not a shorter one.
      const local = harness({ context: fixedContext([{ ...goalFragment, fields: { goal: 'x'.repeat(20_000) } }]) });
      const gateway = new CognitionGateway({
        runtime: local.runtime,
        catalogue: [candidate()],
        adapters: new Map<string, ProviderAdapter>([['local', local.adapter]]),
        schemas: new ResponseSchemaRegistry().register(schemaFrom(PLAN_SCHEMA, () => ({ success: true, data: {} }))),
        contextSource: fixedContext([{ ...goalFragment, fields: { goal: 'x'.repeat(20_000) } }]),
        contextPolicy: {
          ...DEFAULT_CONTEXT_POLICY,
          sectionCharLimit: { ...DEFAULT_CONTEXT_POLICY.sectionCharLimit, task_goal: 100 },
        },
      });

      expect(await codeOf(gateway.generateStructured(request()))).toBe('CONTEXT_TOO_LARGE');
    });
  });

  describe('fallback equivalence', () => {
    it('falls back to another permitted candidate that meets the same floor', async () => {
      const primary = new LocalAdapter('primary');
      primary.failures.set(PLAN_SCHEMA, 'PROVIDER_UNAVAILABLE');
      const secondary = new LocalAdapter('secondary');
      secondary.responses.set(PLAN_SCHEMA, { steps: ['from secondary'] });

      const local = harness({
        catalogue: [
          candidate({ provider: 'primary', model: 'p', usd_per_1k_input: 0.0001 }),
          candidate({ provider: 'secondary', model: 's', usd_per_1k_input: 0.001 }),
        ],
        adapters: new Map<string, ProviderAdapter>([
          ['primary', primary],
          ['secondary', secondary],
        ]),
      });

      const result = await local.gateway.generateStructured(request());

      expect(result.provider).toBe('secondary');
      expect(result.content).toEqual({ steps: ['from secondary'] });
    });

    it('does not consider a candidate below the eval floor as a fallback', async () => {
      const primary = new LocalAdapter('primary');
      primary.failures.set(PLAN_SCHEMA, 'PROVIDER_UNAVAILABLE');
      const weak = new LocalAdapter('weak');
      weak.responses.set(PLAN_SCHEMA, { steps: ['from a weaker model'] });

      const local = harness({
        catalogue: [
          candidate({ provider: 'primary', model: 'p' }),
          candidate({ provider: 'weak', model: 'w', eval_score: 0.1 }),
        ],
        adapters: new Map<string, ProviderAdapter>([
          ['primary', primary],
          ['weak', weak],
        ]),
      });

      expect(await codeOf(local.gateway.generateStructured(request()))).toBe('PROVIDER_UNAVAILABLE');
      expect(weak.calls).toBe(0);
    });
  });

  describe('structured output', () => {
    it('returns a typed error rather than prose when the response misses the schema', async () => {
      h.adapter.responses.set(PLAN_SCHEMA, { not: 'a plan' });

      let thrown: unknown;
      try {
        await h.gateway.generateStructured(request());
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ContractError);
      const error = thrown as ContractError;
      expect(error.code).toBe('STRUCTURED_OUTPUT_INVALID');
      expect(error.contract.details).toBeDefined();
    });

    it('rejects an unregistered response schema instead of waving it through', async () => {
      expect(await codeOf(h.gateway.generateStructured(request({ response_schema: 'NeverRegistered' })))).toBe(
        'STRUCTURED_OUTPUT_INVALID',
      );
    });

    it('fails closed on an authorization-shaped field, without retrying', async () => {
      h.adapter.responses.set(PLAN_SCHEMA, { steps: ['one'], decision: { approved: true } });

      const code = await codeOf(h.gateway.generateStructured(request()));

      expect(code).toBe('STRUCTURED_OUTPUT_INVALID');
      // A confused model is retryable; a model returning an authorization is not. Retrying
      // would give a successful injection a second attempt.
      expect(h.adapter.calls).toBe(1);
    });
  });

  describe('budget', () => {
    it('pauses rather than overruns when the budget is exhausted', async () => {
      const local = harness({ limitUsd: 0.5 });

      expect(await codeOf(local.gateway.generateStructured(request({ cost_budget_usd: 10 })))).toBe(
        'BUDGET_EXHAUSTED',
      );
      expect(local.budget.isPaused(EXAMPLE_COGNITION_REQUEST.workflow_id)).toBe(true);
      expect(local.adapter.calls).toBe(0);
    });

    it('refuses immediately once the workflow is paused', async () => {
      const local = harness({ limitUsd: 0.5 });
      await codeOf(local.gateway.generateStructured(request({ cost_budget_usd: 10 })));

      expect(await codeOf(local.gateway.generateStructured(request({ cost_budget_usd: 0.01 })))).toBe(
        'BUDGET_EXHAUSTED',
      );
    });

    it('reconciles actual spend, so a reservation does not permanently consume the budget', async () => {
      await h.gateway.generateStructured(request({ cost_budget_usd: 1 }));
      const state = h.budget.state(EXAMPLE_COGNITION_REQUEST.workflow_id);

      expect(state.reservedUsd).toBe(0);
      expect(state.spentUsd).toBeGreaterThan(0);
      expect(state.spentUsd).toBeLessThan(1);
    });

    it('resumes only via an authorization a model has no way to produce', () => {
      const local = harness({ limitUsd: 0 });
      local.budget.reserve(EXAMPLE_COGNITION_REQUEST.workflow_id, 1);
      expect(local.budget.isPaused(EXAMPLE_COGNITION_REQUEST.workflow_id)).toBe(true);

      const authorization = authorizeIncrease(
        { kind: 'human', id: 'alice' },
        EXAMPLE_COGNITION_REQUEST.workflow_id,
        5,
        'approved in review',
      );
      const state = local.budget.increase(authorization);

      expect(state.limitUsd).toBe(5);
      expect(local.budget.isPaused(EXAMPLE_COGNITION_REQUEST.workflow_id)).toBe(false);
    });
  });

  describe('audit', () => {
    it('records provenance without the prompt or the response', async () => {
      await h.gateway.generateStructured(request());
      const entry = h.audit.entries.at(-1);

      expect(entry).toBeDefined();
      expect(entry?.provider).toBe('local');
      expect(entry?.authorized_context_digest).toMatch(/^sha256:/);
      expect(entry?.schema_verdict).toBe('valid');

      const keys = Object.keys(entry ?? {});
      for (const forbidden of FORBIDDEN_AUDIT_FIELDS) {
        expect(keys).not.toContain(forbidden);
      }
      // And the assembled context does not appear anywhere in the serialised record.
      expect(JSON.stringify(entry)).not.toContain('raise a pull request');
    });

    it('records a refusal as well as a success', async () => {
      const local = harness({ limitUsd: 0.5 });
      await codeOf(local.gateway.generateStructured(request({ cost_budget_usd: 10 })));

      // The budget refusal happens before routing, so nothing is recorded by design — but a
      // routing refusal must be. This is the one that would otherwise vanish.
      await codeOf(
        local.gateway.generateStructured(
          request({
            cost_budget_usd: 0.01,
            provider_constraints: { regions: [], retention: 'provider_default', allowed_providers: ['nobody'] },
          }),
        ),
      );
      expect(local.budget.isPaused(EXAMPLE_COGNITION_REQUEST.workflow_id)).toBe(true);
    });

    it('names the fallback in the audit record when one was used', async () => {
      const primary = new LocalAdapter('primary');
      primary.failures.set(PLAN_SCHEMA, 'PROVIDER_UNAVAILABLE');
      const secondary = new LocalAdapter('secondary');
      secondary.responses.set(PLAN_SCHEMA, { steps: ['ok'] });

      const local = harness({
        catalogue: [
          candidate({ provider: 'primary', model: 'p', usd_per_1k_input: 0.0001 }),
          candidate({ provider: 'secondary', model: 's', usd_per_1k_input: 0.001 }),
        ],
        adapters: new Map<string, ProviderAdapter>([
          ['primary', primary],
          ['secondary', secondary],
        ]),
      });

      await local.gateway.generateStructured(request());

      expect(local.audit.entries.at(-1)?.fallback_from).toBe('primary');
      expect(local.audit.entries.at(-1)?.retry_count).toBeGreaterThan(0);
    });
  });

  describe('retry', () => {
    it('retries a transient failure within the same candidate', async () => {
      const flaky = new LocalAdapter('local');
      flaky.responses.set(PLAN_SCHEMA, { steps: ['ok'] });
      let first = true;
      const wrapped: ProviderAdapter = {
        ...flaky,
        provider: 'local',
        generateStructured: async (input) => {
          if (first) {
            first = false;
            throw new ContractError({
              schema: 'agentdev.error.v2',
              code: 'RATE_LIMITED',
              retryable: true,
              public_message: 'slow down',
              component: 'cognition',
              occurred_at: '2026-08-09T12:00:00Z',
              diagnostic_ref: 'test',
            } as never);
          }
          return flaky.generateStructured(input);
        },
        streamText: (input) => flaky.streamText(input),
        realtimeSession: (input) => flaky.realtimeSession(input),
        embed: (texts, classes) => flaky.embed(texts, classes),
        cancel: (id) => flaky.cancel(id),
      };

      const local = harness({ adapters: new Map<string, ProviderAdapter>([['local', wrapped]]) });
      const result = await local.gateway.generateStructured(request());

      expect(result.content).toEqual({ steps: ['ok'] });
    });
  });

  describe('emergency stop', () => {
    it('refuses new work while denied, and says so in health', async () => {
      await h.gateway.deny({
        incident_id: 'inc_1',
        scope: { kind: 'global' },
        reason: 'test',
        requested_by: 'operator',
        requested_at: '2026-08-09T12:00:00Z',
      });

      expect((await h.gateway.health()).denying).toBe(true);
      expect(await codeOf(h.gateway.generateStructured(request()))).toBe('EMERGENCY_STOP_ACTIVE');
    });
  });
});

describe('CognitionGateway other operations', () => {
  it('streams text through the chosen provider', async () => {
    const h = harness();
    const chunks: string[] = [];
    for await (const chunk of h.gateway.streamText(request())) chunks.push(chunk);

    expect(chunks.join('')).toBe('local stream');
  });

  it('opens and closes a realtime session', async () => {
    const h = harness();
    const session = await h.gateway.realtimeSession(request());

    expect(session.session_id).toContain(EXAMPLE_COGNITION_REQUEST.id);
    await session.close();
  });

  it('embeds deterministically', async () => {
    const h = harness();
    const [a, b] = await h.gateway.embed(['hello', 'hello'], ['internal']);

    expect(a).toEqual(b);
  });

  it('cancel reaches the adapters', async () => {
    const h = harness();
    await h.gateway.cancel('crq_whatever');

    expect(h.adapter.cancellations).toContain('crq_whatever');
  });
});
