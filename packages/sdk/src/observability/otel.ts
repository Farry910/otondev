import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import type { Span, Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import type { SpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { isSecretFieldName, redact } from '@otondev/contracts';
import type { Component } from '@otondev/contracts';

/**
 * OpenTelemetry bootstrap (W0-E).
 *
 * One function so every service produces spans that join up, and one guard so a span
 * attribute cannot become the leak that the log redactor was written to prevent.
 *
 * The endpoint is a parameter, not an environment variable read in here. Configuration
 * arrives through a factory argument everywhere in this codebase (see the `no-restricted-
 * syntax` ESLint rule) so that a secret can never become ambient — an OTLP endpoint often
 * carries an auth token in its headers.
 */

export interface TelemetryOptions {
  service: Component;
  version: string;
  environment: string;
  /** OTLP HTTP endpoint. Omit and spans stay in-process: the correct default for tests. */
  otlpEndpoint?: string;
  otlpHeaders?: Record<string, string>;
  /** Injected for tests. Overrides the OTLP exporter entirely. */
  exporter?: SpanExporter;
  /** Export each span as it ends rather than in batches. Tests want this; production does not. */
  simpleProcessor?: boolean;
  /**
   * Install as the global provider and context manager. True in production so third-party
   * instrumentation joins the same trace. False when several providers coexist in one
   * process — a test file, mainly — because only the first global registration wins and the
   * rest are silently ignored.
   */
  registerGlobal?: boolean;
}

export interface Telemetry {
  tracer: Tracer;
  /** Export everything buffered without tearing down. */
  flush(): Promise<void>;
  /** Flush and stop. Call before exit or spans in flight are lost. */
  shutdown(): Promise<void>;
}

export function initTelemetry(options: TelemetryOptions): Telemetry {
  const exporter =
    options.exporter ??
    (options.otlpEndpoint === undefined
      ? undefined
      : new OTLPTraceExporter({
          url: `${options.otlpEndpoint.replace(/\/$/, '')}/v1/traces`,
          ...(options.otlpHeaders === undefined ? {} : { headers: options.otlpHeaders }),
        }));

  // Processors are constructor-time in the OTel 2.x Node SDK; there is no addSpanProcessor.
  // With no exporter the provider still traces in-process, which is what tests want and what
  // a service with no collector configured should do rather than failing to start.
  const spanProcessors =
    exporter === undefined
      ? []
      : [options.simpleProcessor === true ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter)];

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.service,
      [ATTR_SERVICE_VERSION]: options.version,
      'deployment.environment.name': options.environment,
    }),
    spanProcessors,
  });

  if (options.registerGlobal !== false) provider.register();

  return {
    // From the provider, not from the global `trace.getTracer`. The global returns a no-op
    // tracer whenever registration did not take — a second provider in one process, an api
    // package resolved twice — and a no-op tracer fails silently, which is the worst way for
    // observability to fail.
    tracer: provider.getTracer(options.service, options.version),
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}

export type SpanAttributes = Record<string, string | number | boolean>;

/**
 * Set attributes on a span with the same field-name rules the logger uses.
 *
 * A span is a log line with better indexing, and it leaves the process the same way. Using
 * `span.setAttributes` directly bypasses this; the codebase should not.
 */
export function setSafeAttributes(span: Span, attributes: SpanAttributes): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (isSecretFieldName(key)) {
      span.setAttribute(key, '[redacted]');
      continue;
    }
    span.setAttribute(key, typeof value === 'string' ? (redact(value) as string) : value);
  }
}

/**
 * Run `fn` inside a span, recording the outcome.
 *
 * Errors are recorded as a status and a code, never as a message assembled from a provider
 * response — the same rule the error contract enforces (contracts §11).
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name);
  setSafeAttributes(span, attributes);
  try {
    return await context.with(trace.setSpan(context.active(), span), () => fn(span));
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'INTERNAL';
    span.setStatus({ code: SpanStatusCode.ERROR, message: code });
    span.setAttribute('error.code', code);
    throw error;
  } finally {
    span.end();
  }
}
