import { createHash } from 'node:crypto';
import { ContractError, makeError } from '@otondev/contracts';
import type { CognitionRequest, CognitionResult, DataClass, ErrorCode } from '@otondev/contracts';
import { ControlState } from '@otondev/sdk';
import type {
  CognitionClient,
  ControlAck,
  DenyRequest,
  HealthReport,
  QuarantineRequest,
  RealtimeSession,
  RevokeRequest,
  RuntimeContext,
} from '@otondev/sdk';
import {
  DEFAULT_CONTEXT_POLICY,
  buildContext,
  type ContextBuilderPolicy,
  type ContextFragment,
  type BuiltContext,
} from './context-builder.js';
import { DEFAULT_ROUTING_POLICY, selectRoute, type ModelCandidate, type RoutingPolicy } from './routing.js';
import type { ProviderAdapter, ProviderCompletion } from './providers.js';
import { validateResponse } from './validation.js';
import type { ResponseSchemaRegistry } from './validation.js';
import { BudgetLedger } from './budget.js';
import { InMemoryAuditSink, summariseContextForAudit, type AuditSink, type CognitionAuditRecord } from './audit.js';

/**
 * S6 — the Cognition Gateway.
 *
 * Routing steps 6–9 live here; 1–5 are in `routing.ts` as a pure function. The split is not
 * cosmetic: everything above is a decision, everything here is an effect, and keeping the
 * decision pure is what lets the fail-closed properties be tested exhaustively without a
 * provider.
 *
 * Two invariants are structural rather than checked:
 *
 *   - **No authorization leaves here.** `CognitionResult` has no field for one, none of the
 *     methods can express one, and any authorization-shaped field in a model response is a
 *     hard validation failure rather than a stripped key. Stripping would let a compromised
 *     model keep trying silently.
 *   - **A fallback can only be equal or worse on quality, never weaker on data policy.**
 *     Fallbacks come from the alternates the router already filtered, so there is no path from
 *     a failure to a provider the tenant's policy excluded.
 */

/** Where authorized context fields come from. S13 in production; a fake or fixture in tests. */
export interface ContextSource {
  fetch(request: CognitionRequest): Promise<readonly ContextFragment[]>;
}

export interface CognitionGatewayOptions {
  readonly runtime: RuntimeContext;
  readonly catalogue: readonly ModelCandidate[];
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly schemas: ResponseSchemaRegistry;
  readonly contextSource: ContextSource;
  readonly budget?: BudgetLedger;
  readonly audit?: AuditSink;
  readonly routingPolicy?: RoutingPolicy;
  readonly contextPolicy?: ContextBuilderPolicy;
  readonly promptTemplateVersion?: string;
  /** Attempts per candidate, including the first. Retries stay inside the original budget. */
  readonly maxAttemptsPerCandidate?: number;
  readonly instance?: string;
}

/**
 * Truncating these is not a degraded prompt, it is a different prompt: the model would be
 * asked to follow instructions it was never shown. Better to refuse than to answer a question
 * nobody asked.
 */
const INSTRUCTION_SECTIONS = new Set(['system_behavior', 'task_goal']);

export class CognitionGateway implements CognitionClient {
  readonly serviceId = 'cognition' as const;

  readonly #runtime: RuntimeContext;
  readonly #catalogue: readonly ModelCandidate[];
  readonly #adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly #schemas: ResponseSchemaRegistry;
  readonly #contextSource: ContextSource;
  readonly #budget: BudgetLedger;
  readonly #audit: AuditSink;
  readonly #routingPolicy: RoutingPolicy;
  readonly #contextPolicy: ContextBuilderPolicy;
  readonly #promptTemplateVersion: string;
  readonly #maxAttempts: number;
  readonly #instance: string;
  readonly #control: ControlState;
  readonly #inFlight = new Map<string, AbortController>();

  constructor(options: CognitionGatewayOptions) {
    this.#runtime = options.runtime;
    this.#catalogue = options.catalogue;
    this.#adapters = options.adapters;
    this.#schemas = options.schemas;
    this.#contextSource = options.contextSource;
    this.#budget = options.budget ?? new BudgetLedger();
    this.#audit = options.audit ?? new InMemoryAuditSink();
    this.#routingPolicy = options.routingPolicy ?? DEFAULT_ROUTING_POLICY;
    this.#contextPolicy = options.contextPolicy ?? DEFAULT_CONTEXT_POLICY;
    this.#promptTemplateVersion = options.promptTemplateVersion ?? 'cognition-v1';
    this.#maxAttempts = options.maxAttemptsPerCandidate ?? 2;
    this.#instance = options.instance ?? 'cognition-1';
    this.#control = new ControlState('cognition', options.runtime.clock);
  }

  // ------------------------------------------------------------------- W0-E control hooks

  async health(): Promise<HealthReport> {
    return {
      service: this.serviceId,
      status: 'ok',
      denying: this.#control.isDenied({ kind: 'global' }),
      detail: `${this.#adapters.size} adapter(s), ${this.#catalogue.length} model(s)`,
      checked_at: this.#runtime.clock.nowIso(),
    };
  }

  async deny(request: DenyRequest): Promise<ControlAck> {
    this.#control.recordDeny(request);
    return this.#control.ack('contained', ['cognition:new-work']);
  }

  async quarantine(request: QuarantineRequest): Promise<ControlAck> {
    const id = request.scope.id ?? this.serviceId;
    this.#control.recordQuarantine(id);
    // Abort anything already running for that scope. A quarantine that only stops future work
    // has not isolated the thing that is currently running.
    const contained: string[] = [];
    for (const [requestId, controller] of this.#inFlight) {
      controller.abort();
      contained.push(requestId);
    }
    return this.#control.ack(contained.length > 0 ? 'contained' : 'not_applicable', contained);
  }

  async revoke(request: RevokeRequest): Promise<ControlAck> {
    this.#control.bumpRevocationEpoch(request.revocation_epoch);
    return this.#control.ack('not_applicable', []);
  }

  // ------------------------------------------------------------------------ S6 operations

  async generateStructured(request: CognitionRequest): Promise<CognitionResult> {
    this.#assertNotDenied(request.workflow_id);

    if (this.#budget.isPaused(request.workflow_id)) {
      this.#fail('BUDGET_EXHAUSTED', { workflow_id: request.workflow_id, state: 'paused' });
    }

    const context = await this.#buildContext(request);

    // Steps 1–5.
    const route = selectRoute(request, this.#catalogue, this.#routingPolicy);
    if (!route.ok) {
      await this.#recordRefusal(request, context, route.code, route.reason);
      this.#fail(
        route.code === 'NO_PROVIDER_HEALTHY' ? 'PROVIDER_UNAVAILABLE' : 'DATA_PROVIDER_FORBIDDEN',
        { routing_code: route.code, reason: route.reason },
      );
    }

    // Step 6 — reserve budget against the request's own ceiling, then pin versions.
    const reservation = this.#reserve(request);

    // Steps 7–8, across the chosen candidate and then its equivalent fallbacks. `alternates`
    // came out of the same constraint filter as `chosen`, so trying one cannot weaken the
    // data policy — the guarantee is upstream, not a check here.
    const candidates = [route.chosen, ...route.alternates];
    let retries = 0;
    let lastError: unknown;

    for (const [index, candidate] of candidates.entries()) {
      const adapter = this.#adapters.get(candidate.provider);
      if (adapter === undefined) {
        lastError = new Error(`no adapter registered for provider '${candidate.provider}'`);
        continue;
      }

      for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
        if (attempt > 1 || index > 0) retries++;
        const controller = new AbortController();
        this.#inFlight.set(request.id, controller);
        const timer = setTimeout(() => controller.abort(), request.latency_budget_ms);

        let completion: ProviderCompletion;
        try {
          completion = await adapter.generateStructured({
            request,
            context,
            candidate,
            promptTemplateVersion: this.#promptTemplateVersion,
            signal: controller.signal,
          });
        } catch (error) {
          lastError = error;
          if (this.#isRetryable(error) && attempt < this.#maxAttempts) {
            continue;
          }
          break; // move to the next candidate
        } finally {
          clearTimeout(timer);
          this.#inFlight.delete(request.id);
        }

        if (completion.finish_reason === 'cancelled') {
          this.#budget.release(reservation.id);
          this.#fail('TIMEOUT', { request_id: request.id, budget_ms: request.latency_budget_ms });
        }

        // Step 8 — validate schema, then forbidden fields (order matters, see validation.ts).
        const validation = validateResponse(completion.content, request.response_schema, this.#schemas);
        if (!validation.ok) {
          // A forbidden field is a security event, not a formatting one: never retried, and
          // the spend is still reconciled because the call really happened.
          if (validation.failure.kind === 'forbidden_field') {
            this.#budget.reconcile(reservation.id, completion.usage.cost_usd);
            await this.#record(request, context, candidate, completion, {
              retries,
              schemaVerdict: 'invalid',
              fallbackFrom: index > 0 ? route.chosen.provider : null,
            });
            this.#fail('STRUCTURED_OUTPUT_INVALID', {
              reason: 'the response contained an authorization-shaped field',
              path: validation.failure.path,
              field: validation.failure.field,
            });
          }

          lastError = validation.failure;
          if (attempt < this.#maxAttempts) continue;
          break;
        }

        // Step 9 — return with provenance and uncertainty. No authorization.
        this.#budget.reconcile(reservation.id, completion.usage.cost_usd);
        await this.#record(request, context, candidate, completion, {
          retries,
          schemaVerdict: 'valid',
          fallbackFrom: index > 0 ? route.chosen.provider : null,
        });

        return this.#result(request, context, candidate, completion, validation.value);
      }
    }

    this.#budget.release(reservation.id);
    await this.#recordRefusal(request, context, 'ALL_CANDIDATES_FAILED', String(lastError));

    if (lastError instanceof ContractError) throw lastError;
    this.#fail('STRUCTURED_OUTPUT_INVALID', {
      reason: 'no permitted candidate produced a response satisfying the required schema',
      candidates: candidates.length,
      retries,
    });
  }

  async *streamText(request: CognitionRequest): AsyncIterable<string> {
    this.#assertNotDenied(request.workflow_id);
    const context = await this.#buildContext(request);
    const route = selectRoute(request, this.#catalogue, this.#routingPolicy);
    if (!route.ok) {
      this.#fail('DATA_PROVIDER_FORBIDDEN', { routing_code: route.code, reason: route.reason });
    }
    const adapter = this.#adapters.get(route.chosen.provider);
    if (adapter === undefined) {
      this.#fail('PROVIDER_UNAVAILABLE', { provider: route.chosen.provider });
    }

    const controller = new AbortController();
    this.#inFlight.set(request.id, controller);
    try {
      yield* adapter.streamText({
        request,
        context,
        candidate: route.chosen,
        promptTemplateVersion: this.#promptTemplateVersion,
        signal: controller.signal,
      });
    } finally {
      this.#inFlight.delete(request.id);
    }
  }

  async realtimeSession(request: CognitionRequest): Promise<RealtimeSession> {
    this.#assertNotDenied(request.workflow_id);
    const context = await this.#buildContext(request);
    const route = selectRoute(request, this.#catalogue, this.#routingPolicy);
    if (!route.ok) {
      this.#fail('DATA_PROVIDER_FORBIDDEN', { routing_code: route.code, reason: route.reason });
    }
    const adapter = this.#adapters.get(route.chosen.provider);
    if (adapter === undefined) {
      this.#fail('PROVIDER_UNAVAILABLE', { provider: route.chosen.provider });
    }

    const controller = new AbortController();
    this.#inFlight.set(request.id, controller);
    const session = await adapter.realtimeSession({
      request,
      context,
      candidate: route.chosen,
      promptTemplateVersion: this.#promptTemplateVersion,
      signal: controller.signal,
    });
    return {
      session_id: session.session_id,
      close: async () => {
        this.#inFlight.delete(request.id);
        await session.close();
      },
    };
  }

  async embed(texts: readonly string[], dataClasses: readonly DataClass[]): Promise<number[][]> {
    this.#assertNotDenied();

    // Embedding sends the text to a provider just as a completion does, so it is subject to
    // the same data-class policy. Treating it as a lesser operation is how restricted text
    // ends up in a vector store hosted somewhere the completion path would have refused.
    const forbidden = dataClasses.filter((cls) => !this.#contextPolicy.permittedDataClasses.includes(cls));
    if (forbidden.length > 0) {
      this.#fail('DATA_PROVIDER_FORBIDDEN', {
        reason: 'data class may not leave the boundary for embedding',
        data_classes: forbidden.join(','),
      });
    }

    // Local first: an embedding that can be computed inside the boundary should be.
    const adapter = [...this.#catalogue]
      .sort((a, b) => Number(b.local) - Number(a.local))
      .map((candidate) => this.#adapters.get(candidate.provider))
      .find((found): found is ProviderAdapter => found !== undefined);
    if (adapter === undefined) {
      this.#fail('PROVIDER_UNAVAILABLE', { reason: 'no adapter is registered for any catalogue provider' });
    }
    return adapter.embed(texts, dataClasses);
  }

  async cancel(requestId: string): Promise<void> {
    this.#inFlight.get(requestId)?.abort();
    this.#inFlight.delete(requestId);
    await Promise.all([...this.#adapters.values()].map((adapter) => adapter.cancel(requestId)));
  }

  // ------------------------------------------------------------------------------ internals

  async #buildContext(request: CognitionRequest): Promise<BuiltContext> {
    const fragments = await this.#contextSource.fetch(request);
    const outcome = buildContext(request, fragments, this.#contextPolicy);

    if (!outcome.ok) {
      // No dedicated secret-in-context code exists in `packages/contracts`; a contract request
      // is raised for one. `DATA_PROVIDER_FORBIDDEN` is the closest true statement in the
      // meantime — no provider may receive this context under data policy — and it carries the
      // BLOCKED transition, which is the right workflow outcome.
      this.#fail('DATA_PROVIDER_FORBIDDEN', { reason: outcome.reason, code: outcome.code });
    }

    const instructionTruncated = outcome.context.truncated.filter((name) => INSTRUCTION_SECTIONS.has(name));
    if (instructionTruncated.length > 0) {
      this.#fail('CONTEXT_TOO_LARGE', {
        reason: 'an instruction section was truncated; the model would answer a question it was not shown',
        sections: instructionTruncated.join(','),
      });
    }

    return outcome.context;
  }

  #reserve(request: CognitionRequest) {
    const outcome = this.#budget.reserve(request.workflow_id, request.cost_budget_usd);
    if (!outcome.ok) {
      this.#fail('BUDGET_EXHAUSTED', {
        workflow_id: request.workflow_id,
        remaining_usd: outcome.remainingUsd,
        requested_usd: outcome.requestedUsd,
      });
    }
    return outcome.reservation;
  }

  #result(
    request: CognitionRequest,
    context: BuiltContext,
    candidate: ModelCandidate,
    completion: ProviderCompletion,
    content: unknown,
  ): CognitionResult {
    const id = this.#runtime.ids.next('cognitionRequest');
    const templateDigest = `sha256:${createHash('sha256').update(this.#promptTemplateVersion).digest('hex')}`;
    return {
      schema: 'agentdev.cognition_result.v2',
      id,
      tenant_id: request.tenant_id,
      correlation_id: request.correlation_id,
      created_at: this.#runtime.clock.nowIso(),
      producer: { service: 'cognition', instance: this.#instance, version: '0.1.0' },
      data_classes: context.dataClasses.length > 0 ? [...context.dataClasses] : [...request.data_classes],
      integrity: {
        alg: 'sha256',
        digest: createHash('sha256').update(`agentdev.cognition_result.v2:${id}`).digest('hex'),
      },
      request_id: request.id,
      workflow_id: request.workflow_id,
      provider: candidate.provider,
      model: candidate.model,
      model_version: completion.model_version,
      prompt_template: { version: this.#promptTemplateVersion, digest: templateDigest },
      authorized_context_digest: context.digest,
      content,
      schema_verdict: 'valid',
      usage: completion.usage,
      uncertainty: completion.uncertainty,
      citations: [...completion.citations],
      // Budget state is deliberately absent: it belongs to the workflow, not to a model
      // result, and carrying it here would invite treating it as something the model reported.
      completion_reason: completion.finish_reason === 'length' ? 'length' : 'stop',
      completed_at: this.#runtime.clock.nowIso(),
    } as CognitionResult;
  }

  async #record(
    request: CognitionRequest,
    context: BuiltContext,
    candidate: ModelCandidate,
    completion: ProviderCompletion,
    extra: { retries: number; schemaVerdict: CognitionAuditRecord['schema_verdict']; fallbackFrom: string | null },
  ): Promise<void> {
    await this.#audit.record({
      request_id: request.id,
      workflow_id: request.workflow_id,
      tenant_id: request.tenant_id,
      agent_id: request.agent_id,
      purpose: request.purpose,
      risk: request.risk,
      provider: candidate.provider,
      model: candidate.model,
      model_version: completion.model_version,
      prompt_template_version: this.#promptTemplateVersion,
      prompt_template_digest: `sha256:${createHash('sha256').update(this.#promptTemplateVersion).digest('hex')}`,
      data_classes: context.dataClasses,
      ...summariseContextForAudit(context),
      usage: completion.usage,
      retry_count: extra.retries,
      fallback_from: extra.fallbackFrom,
      schema_verdict: extra.schemaVerdict,
      completion_reason: completion.finish_reason,
      observed_at: this.#runtime.clock.nowIso(),
    });
  }

  async #recordRefusal(
    request: CognitionRequest,
    context: BuiltContext | undefined,
    code: string,
    reason: string,
  ): Promise<void> {
    await this.#audit.record({
      request_id: request.id,
      workflow_id: request.workflow_id,
      tenant_id: request.tenant_id,
      agent_id: request.agent_id,
      purpose: request.purpose,
      risk: request.risk,
      provider: 'none',
      model: 'none',
      model_version: 'none',
      prompt_template_version: this.#promptTemplateVersion,
      prompt_template_digest: `sha256:${createHash('sha256').update(this.#promptTemplateVersion).digest('hex')}`,
      data_classes: context?.dataClasses ?? request.data_classes,
      context_sections: context?.sections.map((s) => ({ name: s.name, chars: s.chars })) ?? [],
      authorized_context_digest: context?.digest ?? 'sha256:' + '0'.repeat(64),
      dlp_verdict: {
        findings: context?.secretFindings.length ?? 0,
        kinds: [...new Set((context?.secretFindings ?? []).map((f) => f.kind))],
        action: 'refused',
      },
      untrusted_sources: context?.untrustedSources ?? [],
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms: 0 },
      retry_count: 0,
      fallback_from: null,
      schema_verdict: 'not_applicable',
      completion_reason: `refused:${code}:${reason.slice(0, 120)}`,
      observed_at: this.#runtime.clock.nowIso(),
    });
  }

  #isRetryable(error: unknown): boolean {
    // The adapter classified it; the gateway does not second-guess a vendor error it cannot
    // see. "Retry only transient failures" is the rule, and `retryable` is where transience is
    // recorded once, in the contracts package, rather than re-derived per call site.
    return error instanceof ContractError && error.retryable;
  }

  #assertNotDenied(scopeId?: string): void {
    const denied =
      this.#control.isDenied({ kind: 'global' }) ||
      (scopeId !== undefined && this.#control.isDenied({ kind: 'workflow', id: scopeId }));
    if (denied) this.#fail('EMERGENCY_STOP_ACTIVE');
  }

  #fail(code: ErrorCode, details?: Record<string, string | number | boolean | null>): never {
    throw new ContractError(
      makeError(code, {
        diagnostic_ref: `cognition:${this.#instance}:${this.#runtime.clock.nowIso()}`,
        occurred_at: this.#runtime.clock.nowIso(),
        ...(details === undefined ? {} : { details }),
      }),
    );
  }
}
