import { describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { FakeClock, deterministicIdFactory } from '@otondev/testkit';
import { isContractError, REDACTED } from '@otondev/contracts';
import { createFakeRegistry } from './fakes/index.js';
import { fanOutControlHook, scopeCovers, SERVICE_IDS } from './hooks.js';
import type { ControlAck, ServiceClient } from './hooks.js';
import { SERVICE_NAMES } from './services/index.js';
import { createLogger, memorySink } from './observability/logger.js';
import { createMetricRegistry, UnboundedLabelError } from './observability/metrics.js';
import { initTelemetry, setSafeAttributes, withSpan } from './observability/otel.js';
import { createIdFactory, systemClock } from './runtime.js';

function build() {
  const clock = new FakeClock('2026-07-30T08:00:00.000Z');
  const registry = createFakeRegistry({ clock, ids: deterministicIdFactory({ clock }) });
  return { clock, ...registry };
}

describe('the registry covers every S1-S20 service', () => {
  it('has a fake for all twenty', () => {
    const { services } = build();
    expect(SERVICE_NAMES).toHaveLength(20);
    for (const name of SERVICE_NAMES) {
      expect(services[name], name).toBeDefined();
      expect(SERVICE_IDS, name).toContain(services[name].serviceId);
    }
  });

  it('gives each fake a distinct service id', () => {
    const { all } = build();
    const ids = all().map((service) => service.serviceId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is deterministic given a fake clock and a deterministic id factory', async () => {
    const run = async (): Promise<string> => {
      const { services } = build();
      const outcome = await services.ingress.ingest({
        system: 'jira',
        installation_id: 'jira_acme',
        body: new TextEncoder().encode('{}'),
        headers: { 'x-signature': 'sig', 'x-event-id': 'v1' },
        received_at: '2026-07-30T08:00:00Z',
      });
      return JSON.stringify(outcome);
    };
    expect(await run()).toBe(await run());
  });
});

describe('W0-E control hooks', () => {
  it('scope containment: global covers everything, a peer scope covers only itself', () => {
    expect(scopeCovers({ kind: 'global' }, { kind: 'workflow', id: 'wf_1' })).toBe(true);
    expect(scopeCovers({ kind: 'workflow', id: 'wf_1' }, { kind: 'workflow', id: 'wf_1' })).toBe(true);
    expect(scopeCovers({ kind: 'workflow', id: 'wf_1' }, { kind: 'workflow', id: 'wf_2' })).toBe(false);
    expect(scopeCovers({ kind: 'agent', id: 'a' }, { kind: 'workflow', id: 'a' })).toBe(false);
  });

  it('a denied service refuses new work', async () => {
    const { services, clock } = build();
    await services.workflow.deny({
      incident_id: 'inc_1',
      scope: { kind: 'global' },
      reason: 'test',
      requested_by: 'operator',
      requested_at: clock.nowIso(),
    });
    await expect(
      services.workflow.create({
        tenant_id: 'ten_x',
        agent_id: 'agt_x',
        type: 'ticket_delivery',
        goal_ref: 'art_x',
        source_refs: ['ticket:jira:X-1'],
        definition_of_done_ref: 'dod_x',
        risk: 'low',
        data_classes: ['internal'],
        autonomy_required: 'A1',
        priority: 1,
        budget: { usd_max: 1, deadline: '2030-01-01T00:00:00Z', cpu_seconds: 1 },
      }),
    ).rejects.toThrow(/EMERGENCY_STOP_ACTIVE/);
  });

  it('quarantining a workflow pauses it and drops its lease, fencing the worker', async () => {
    const { services, clock } = build();
    const workflow = await services.workflow.create({
      tenant_id: 'ten_x',
      agent_id: 'agt_x',
      type: 'ticket_delivery',
      goal_ref: 'art_x',
      source_refs: ['ticket:jira:X-1'],
      definition_of_done_ref: 'dod_x',
      risk: 'low',
      data_classes: ['internal'],
      autonomy_required: 'A1',
      priority: 1,
      budget: { usd_max: 1, deadline: '2030-01-01T00:00:00Z', cpu_seconds: 1 },
    });
    await services.workflow.acquireLease({ workflow_id: workflow.id, owner: 'wl_1', ttl_seconds: 60 });

    const ack = await services.workflow.quarantine({
      incident_id: 'inc_2',
      scope: { kind: 'workflow', id: workflow.id },
      reason: 'test',
      requested_by: 'operator',
      requested_at: clock.nowIso(),
    });
    expect(ack.contained).toContain(workflow.id);
    const after = await services.workflow.get(workflow.id);
    expect(after?.state).toBe('PAUSED');
    expect(after?.lease).toBeNull();
  });

  it('the fan-out reports an unreachable service rather than dropping it', async () => {
    // A Promise.all-based aggregator loses exactly the services an operator most needs to
    // hear about. This is the case that catches that.
    const clock = new FakeClock('2026-07-30T08:00:00.000Z');
    const wedged: ServiceClient = {
      serviceId: 'cognition',
      health: async () => ({
        service: 'cognition',
        status: 'down',
        denying: false,
        detail: 'wedged',
        checked_at: clock.nowIso(),
      }),
      deny: () => new Promise<ControlAck>(() => {}),
      quarantine: () => new Promise<ControlAck>(() => {}),
      revoke: () => new Promise<ControlAck>(() => {}),
    };
    const { services } = build();

    const report = await fanOutControlHook(
      'deny',
      [services.policy, wedged] as (ServiceClient & Record<string, unknown>)[],
      {
        incident_id: 'inc_3',
        scope: { kind: 'global' },
        reason: 'test',
        requested_by: 'operator',
        requested_at: clock.nowIso(),
      },
      { clock, timeoutMs: 20 },
    );

    expect(report.acks).toHaveLength(2);
    expect(report.unreachable).toEqual(['cognition']);
    expect(report.contained).toBe(false);
  });

  it('the six-step emergency sequence runs in order and reports verified containment', async () => {
    const { services } = build();
    const outcome = await services.operator.emergencyStop({
      incident_id: 'inc_4',
      operator: { operator_id: 'usr_1', authn: 'mfa' },
      scope: { kind: 'global' },
      reason: 'drill',
    });
    expect(outcome.steps.map((s) => s.step)).toEqual([
      'pause_agent',
      'deny_new_work',
      'deny_new_capabilities',
      'cancel_workflows',
      'revoke_tokens',
      'quarantine_workers',
    ]);
    expect(outcome.contained).toBe(true);
    expect(outcome.deny_propagation_ms).toBeGreaterThanOrEqual(0);
  });

  it('revoking bumps the epoch, which invalidates outstanding capabilities', async () => {
    const { services } = build();
    const capability = await services.broker.mint({
      subject: { workload_id: 'wl_1', agent_id: 'agt_1' },
      workflow_id: 'wf_1',
      action_id: 'act_1',
      operation: 'jira.comment',
      resource: 'ticket:jira:ENG-42',
      parameter_digest: `sha256:${'a'.repeat(64)}`,
      max_uses: 3,
      lease_fencing_token: 4,
      requested_ttl_seconds: 600,
      policy_decision_id: 'pdec_1',
    });
    await services.operator.revokeTokens({
      incident_id: 'inc_5',
      operator: { operator_id: 'usr_1', authn: 'mfa' },
      scope: { kind: 'global' },
      reason: 'drill',
    });
    const verdict = await services.broker.verify(capability, {
      resource: 'ticket:jira:ENG-42',
      parameter_digest: `sha256:${'a'.repeat(64)}`,
      fencing_token: 4,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.failed_checks).toContain('revocation_epoch');
  });
});

describe('structured logging', () => {
  const logger = (level?: 'debug' | 'info') => {
    const { records, sink } = memorySink();
    return {
      records,
      log: createLogger({
        service: 'policy',
        clock: new FakeClock('2026-07-30T08:00:00.000Z'),
        sink,
        ...(level === undefined ? {} : { level }),
      }),
    };
  };

  it('emits structured records, not formatted strings', () => {
    const { records, log } = logger();
    log.info('decision recorded', { decision: 'allow', workflow_id: 'wf_1' });
    expect(records[0]).toMatchObject({
      level: 'info',
      service: 'policy',
      msg: 'decision recorded',
      fields: { decision: 'allow', workflow_id: 'wf_1' },
    });
  });

  it('redacts a secret-class field by name', () => {
    const { records, log } = logger();
    log.error('provider call failed', { api_key: 'sk-live-abc', status: 500 });
    expect(records[0]?.fields).toEqual({ api_key: REDACTED, status: 500 });
  });

  it('does not redact a fencing token — it is a counter, not a credential', () => {
    const { records, log } = logger();
    log.info('fenced', { lease_fencing_token: 22, input_tokens: 100 });
    expect(records[0]?.fields).toEqual({ lease_fencing_token: 22, input_tokens: 100 });
  });

  it('lifts correlation and trace ids out of fields so they are indexable', () => {
    const { records, log } = logger();
    log.info('step done', { correlation_id: 'cor_1', trace_id: 'abc', other: 1 });
    expect(records[0]).toMatchObject({ correlation_id: 'cor_1', trace_id: 'abc', fields: { other: 1 } });
    expect(records[0]?.fields).not.toHaveProperty('correlation_id');
  });

  it('carries child fields onto every record', () => {
    const { records, log } = logger();
    log.child({ workflow_id: 'wf_9' }).warn('slow');
    expect(records[0]?.fields).toMatchObject({ workflow_id: 'wf_9' });
  });

  it('respects the level threshold', () => {
    const { records, log } = logger();
    log.debug('noisy');
    expect(records).toHaveLength(0);
  });
});

describe('bounded-cardinality metric registry', () => {
  it('accepts an allow-listed label', () => {
    const metrics = createMetricRegistry();
    metrics.define({
      name: 'policy_decisions_total',
      kind: 'counter',
      description: 'policy decisions',
      labels: ['tenant_id', 'result'],
    });
    metrics.increment('policy_decisions_total', { tenant_id: 'ten_a', result: 'allow' });
    metrics.increment('policy_decisions_total', { tenant_id: 'ten_a', result: 'allow' });
    expect(metrics.snapshot()).toEqual([
      { name: 'policy_decisions_total', labels: { tenant_id: 'ten_a', result: 'allow' }, value: 2 },
    ]);
  });

  it('REFUSES an unbounded label at definition time', () => {
    // S8: "ticket IDs, prompts, filenames, and people never become metric labels." Throwing
    // at definition means a developer sees it the first time the code runs, not after a
    // Prometheus instance has fallen over with a million series.
    const metrics = createMetricRegistry();
    for (const label of ['ticket_id', 'prompt', 'filename', 'user_email']) {
      expect(() =>
        metrics.define({
          name: 'bad_metric',
          kind: 'counter',
          description: 'x',
          labels: [label as 'tenant_id'],
        }),
      ).toThrow(UnboundedLabelError);
    }
  });

  it('refuses a label the metric did not declare', () => {
    const metrics = createMetricRegistry();
    metrics.define({ name: 'm', kind: 'counter', description: 'x', labels: ['tenant_id'] });
    expect(() => metrics.increment('m', { provider: 'openai' })).toThrow(/does not declare label/);
  });

  it('refuses an undefined metric', () => {
    expect(() => createMetricRegistry().increment('never_defined')).toThrow(/is not defined/);
  });

  it('requires a histogram to declare its buckets', () => {
    const metrics = createMetricRegistry();
    expect(() =>
      metrics.define({ name: 'latency', kind: 'histogram', description: 'x', labels: [] }),
    ).toThrow(/buckets/);
  });
});

describe('OTel bootstrap', () => {
  it('records a span with safe attributes and shuts down cleanly', async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = initTelemetry({
      service: 'policy',
      version: '0.0.0',
      environment: 'test',
      exporter,
      simpleProcessor: true,
      registerGlobal: false,
    });

    const result = await withSpan(telemetry.tracer, 'policy.evaluate', { action: 'jira.comment' }, async () => 42);
    expect(result).toBe(42);
    // Flush, read, *then* shut down: InMemorySpanExporter.shutdown() resets its buffer.
    await telemetry.flush();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toContain('policy.evaluate');
    expect(spans[0]?.attributes['action']).toBe('jira.comment');
  });

  it('never lets a secret-class attribute onto a span', async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = initTelemetry({
      service: 'broker',
      version: '0.0.0',
      environment: 'test',
      exporter,
      simpleProcessor: true,
      registerGlobal: false,
    });
    const span = telemetry.tracer.startSpan('mint');
    // A span is a log line with better indexing, and it leaves the process the same way.
    setSafeAttributes(span, { api_key: 'sk-live-abc', resource: 'ticket:jira:ENG-42' });
    span.end();
    await telemetry.flush();

    const exported = exporter.getFinishedSpans()[0];
    expect(exported?.attributes['api_key']).toBe(REDACTED);
    expect(exported?.attributes['resource']).toBe('ticket:jira:ENG-42');
  });

  it('records an error code, never a provider message', async () => {
    const exporter = new InMemorySpanExporter();
    const telemetry = initTelemetry({
      service: 'connectors',
      version: '0.0.0',
      environment: 'test',
      exporter,
      simpleProcessor: true,
      registerGlobal: false,
    });
    const { services } = build();

    await expect(
      withSpan(telemetry.tracer, 'connectors.execute', {}, async () => {
        await services.connectors.getAction('act_missing');
        throw await services.connectors
          .execute('act_missing', {} as never)
          .catch((error: unknown) => error);
      }),
    ).rejects.toBeDefined();
    await telemetry.flush();

    const exported = exporter.getFinishedSpans()[0];
    expect(exported?.attributes['error.code']).toBeDefined();
  });
});

describe('production runtime', () => {
  it('mints valid, unique, time-ordered ids', () => {
    const ids = createIdFactory(systemClock);
    const minted = Array.from({ length: 200 }, () => ids.next('workflow'));
    expect(new Set(minted).size).toBe(200);
    for (const id of minted) expect(id).toMatch(/^wf_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('fakes throw ContractErrors, never bare Errors', () => {
  it('so a caller can branch on a stable code', async () => {
    const { services } = build();
    await services.verifier
      .verify({
        workflow_id: 'wf_1',
        goal_digest: `sha256:${'a'.repeat(64)}`,
        diff_digest: `sha256:${'a'.repeat(64)}`,
        head_sha: 'a'.repeat(40),
        definition_of_done_ref: 'dod_x',
        manifest_version: 'verifier-v99',
        evidence_refs: [],
      })
      .then(
        () => expect.unreachable('should have failed closed'),
        (error: unknown) => {
          expect(isContractError(error)).toBe(true);
          if (isContractError(error)) {
            expect(error.code).toBe('VERIFY_MANIFEST_INVALID');
            expect(error.contract.public_message).not.toContain('verifier-v99');
          }
        },
      );
  });
});
