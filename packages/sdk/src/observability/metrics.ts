import { ALLOWED_METRIC_LABELS, isAllowedMetricLabel } from '@otondev/contracts';
import type { AllowedMetricLabel } from '@otondev/contracts';

/**
 * The bounded-cardinality metric registry.
 *
 * S8's exit criterion is that "ticket IDs, prompts, filenames, and people never become
 * metric labels". Enforced here rather than reviewed, because the failure mode is silent
 * until a Prometheus instance falls over, at which point the offending label has been in
 * production for a week and the series cannot be deleted retroactively.
 *
 * A label not on {@link ALLOWED_METRIC_LABELS} throws at *registration* time — when a
 * developer runs the code once — rather than being dropped at emit time, which would hide
 * the mistake until someone went looking for a metric that was never there.
 */

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricDefinition {
  name: string;
  kind: MetricKind;
  description: string;
  labels: readonly AllowedMetricLabel[];
  /** Histogram bucket boundaries. Required for histograms so buckets are reviewed, not guessed. */
  buckets?: readonly number[];
}

export class UnboundedLabelError extends Error {
  readonly metric: string;
  readonly label: string;

  constructor(metric: string, label: string) {
    super(
      `metric "${metric}" declares label "${label}", which is not on the bounded-cardinality ` +
        `allow-list. Permitted: ${ALLOWED_METRIC_LABELS.join(', ')}. If this label really is ` +
        `bounded, add it to the contracts allow-list through a contract request — not here.`,
    );
    this.name = 'UnboundedLabelError';
    this.metric = metric;
    this.label = label;
  }
}

export interface MetricSample {
  name: string;
  labels: Partial<Record<AllowedMetricLabel, string>>;
  value: number;
}

export interface MetricRegistry {
  define(definition: MetricDefinition): void;
  increment(name: string, labels?: Partial<Record<AllowedMetricLabel, string>>, by?: number): void;
  set(name: string, value: number, labels?: Partial<Record<AllowedMetricLabel, string>>): void;
  observe(name: string, value: number, labels?: Partial<Record<AllowedMetricLabel, string>>): void;
  /** Everything recorded so far. The seam a test and an exporter both use. */
  snapshot(): MetricSample[];
  definitions(): MetricDefinition[];
}

export function createMetricRegistry(): MetricRegistry {
  const definitions = new Map<string, MetricDefinition>();
  const samples = new Map<string, MetricSample>();

  const keyOf = (name: string, labels: Partial<Record<string, string>>): string =>
    `${name}{${Object.entries(labels)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v ?? ''}`)
      .join(',')}}`;

  const definitionFor = (name: string): MetricDefinition => {
    const definition = definitions.get(name);
    if (definition === undefined) {
      throw new Error(`metric "${name}" is not defined. Declare it with define() first.`);
    }
    return definition;
  };

  const checkLabels = (definition: MetricDefinition, labels: Partial<Record<string, string>>): void => {
    for (const label of Object.keys(labels)) {
      if (!isAllowedMetricLabel(label)) throw new UnboundedLabelError(definition.name, label);
      if (!definition.labels.includes(label)) {
        throw new Error(`metric "${definition.name}" does not declare label "${label}"`);
      }
    }
  };

  const record = (name: string, labels: Partial<Record<AllowedMetricLabel, string>>, value: number, add: boolean): void => {
    const definition = definitionFor(name);
    checkLabels(definition, labels);
    const key = keyOf(name, labels);
    const existing = samples.get(key);
    samples.set(key, {
      name,
      labels,
      value: add && existing !== undefined ? existing.value + value : value,
    });
  };

  return {
    define(definition) {
      for (const label of definition.labels) {
        if (!isAllowedMetricLabel(label)) throw new UnboundedLabelError(definition.name, label);
      }
      if (definition.kind === 'histogram' && definition.buckets === undefined) {
        throw new Error(`histogram "${definition.name}" must declare its buckets explicitly`);
      }
      definitions.set(definition.name, definition);
    },
    increment: (name, labels = {}, by = 1) => record(name, labels, by, true),
    set: (name, value, labels = {}) => record(name, labels, value, false),
    observe: (name, value, labels = {}) => record(name, labels, value, false),
    snapshot: () => [...samples.values()],
    definitions: () => [...definitions.values()],
  };
}
