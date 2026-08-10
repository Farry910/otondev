import { ContractError, makeError } from '@otondev/contracts';
import type { CognitionRequest, DataClass, ErrorCode } from '@otondev/contracts';
import type { RealtimeSession } from '@otondev/sdk';
import type { BuiltContext } from './context-builder.js';
import type { ModelCandidate } from './routing.js';

/**
 * Provider adapters — cognition-router.md "Provider adapters".
 *
 * Adapters "normalize usage, latency, finish reason, safety/provider errors, and model
 * version". Normalising the *errors* is the part that carries weight: the routing layer above
 * decides whether to retry, and it can only do that if a rate limit from one vendor and a
 * rate limit from another arrive as the same typed thing. An adapter that lets a provider's
 * own error shape escape pushes that vendor knowledge up into the router, where it rots.
 *
 * "Provider-specific tools are disabled unless explicitly part of the adapter contract" — so
 * there is no passthrough of arbitrary provider options in this interface. Adding one later
 * should require editing this file, which is where someone will have to argue for it.
 */

export interface ProviderCallInput {
  readonly request: CognitionRequest;
  readonly context: BuiltContext;
  readonly candidate: ModelCandidate;
  readonly promptTemplateVersion: string;
  /** Cancellation, so `cancel()` and the latency budget both actually stop work. */
  readonly signal: AbortSignal;
}

export type FinishReason = 'stop' | 'length' | 'content_filter' | 'cancelled' | 'error';

export interface ProviderUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_usd: number;
  readonly latency_ms: number;
}

/** What an adapter returns. Deliberately raw: validation is the gateway's job, not the adapter's. */
export interface ProviderCompletion {
  readonly content: unknown;
  readonly usage: ProviderUsage;
  readonly model_version: string;
  readonly finish_reason: FinishReason;
  /** The model's own uncertainty when it can express one. Advisory, never authorising. */
  readonly uncertainty: number | null;
  readonly citations: readonly string[];
}

export interface ProviderAdapter {
  readonly provider: string;
  generateStructured(input: ProviderCallInput): Promise<ProviderCompletion>;
  streamText(input: ProviderCallInput): AsyncIterable<string>;
  realtimeSession(input: ProviderCallInput): Promise<RealtimeSession>;
  embed(texts: readonly string[], dataClasses: readonly DataClass[]): Promise<number[][]>;
  cancel(requestId: string): Promise<void>;
}

/** Normalise a provider failure into a typed, retry-classified contract error. */
export function providerFailure(
  provider: string,
  code: Extract<ErrorCode, 'PROVIDER_UNAVAILABLE' | 'RATE_LIMITED' | 'TIMEOUT'>,
  detail: string,
): ContractError {
  return new ContractError(
    makeError(code, {
      diagnostic_ref: `cognition:${provider}`,
      occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      details: { provider, detail },
    }),
  );
}

/**
 * The offline adapter every test runs against.
 *
 * S6's last exit criterion is "`pnpm test` green **offline** with all peers faked", which
 * makes a deterministic in-process adapter part of the deliverable rather than a testing
 * convenience. It is also the honest default: a gateway whose only adapter needs a network
 * cannot be exercised by the injection corpus or the budget tests at all.
 *
 * Responses come from a caller-supplied map keyed by `response_schema`, so a test states the
 * shape it expects to get back and the adapter does not have to guess.
 */
export class LocalAdapter implements ProviderAdapter {
  readonly provider: string;
  /** Canned structured responses by `response_schema`. */
  readonly responses = new Map<string, unknown>();
  /** Schemas for which the next call should fail, and how. */
  readonly failures = new Map<string, 'PROVIDER_UNAVAILABLE' | 'RATE_LIMITED' | 'TIMEOUT'>();
  /** Incremented per call so a test can assert a retry actually happened. */
  calls = 0;
  cancellations: string[] = [];

  readonly #modelVersion: string;

  constructor(provider = 'local', modelVersion = '0.0.0-local') {
    this.provider = provider;
    this.#modelVersion = modelVersion;
  }

  async generateStructured(input: ProviderCallInput): Promise<ProviderCompletion> {
    this.calls++;
    if (input.signal.aborted) {
      return this.#completion(null, 'cancelled', input);
    }

    const failure = this.failures.get(input.request.response_schema);
    if (failure !== undefined) {
      throw providerFailure(this.provider, failure, `injected ${failure}`);
    }

    const content = this.responses.get(input.request.response_schema) ?? null;
    return this.#completion(content, 'stop', input);
  }

  async *streamText(input: ProviderCallInput): AsyncIterable<string> {
    this.calls++;
    for (const chunk of ['local ', 'stream']) {
      if (input.signal.aborted) return;
      yield chunk;
    }
  }

  async realtimeSession(input: ProviderCallInput): Promise<RealtimeSession> {
    this.calls++;
    const sessionId = `rts_${input.request.id}`;
    return { session_id: sessionId, close: async () => void this.cancellations.push(sessionId) };
  }

  async embed(texts: readonly string[], _dataClasses: readonly DataClass[]): Promise<number[][]> {
    // Deterministic and content-sensitive, so a similarity assertion means something. Matches
    // FakeCognition's shape so a consumer that swapped one for the other sees no difference.
    return texts.map((text) => [text.length, [...text].reduce((n, c) => n + c.charCodeAt(0), 0) % 997]);
  }

  async cancel(requestId: string): Promise<void> {
    this.cancellations.push(requestId);
  }

  #completion(content: unknown, finish: FinishReason, input: ProviderCallInput): ProviderCompletion {
    // Token counts derived from the context so budget arithmetic in tests is not a fiction.
    const inputTokens = Math.ceil(input.context.text.length / 4);
    const outputTokens = Math.ceil(JSON.stringify(content ?? '').length / 4);
    return {
      content,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd:
          (inputTokens / 1000) * input.candidate.usd_per_1k_input +
          (outputTokens / 1000) * input.candidate.usd_per_1k_output,
        latency_ms: 1,
      },
      model_version: this.#modelVersion,
      finish_reason: finish,
      uncertainty: null,
      citations: [],
    };
  }
}
