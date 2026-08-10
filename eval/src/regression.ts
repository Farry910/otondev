/**
 * Cost and latency regression, by pinned version.
 *
 * Contracts §12 requires the policy, prompt, model route, worker image, verifier, persona and
 * memory derivation to be independently versioned. This module is what makes that pay off:
 * a cost or latency number is only comparable to another number taken at the *same* pinned
 * version, so the baseline is keyed by the version tuple rather than by task alone.
 *
 * Comparing across versions is not a regression, it is a **rebaseline** — a distinct outcome,
 * because treating a deliberate model change as a regression trains everyone to ignore the
 * signal, and treating it as a pass hides the cost increase it caused.
 */

export interface PinnedVersions {
  model_route: string;
  prompt_version: string;
  policy_version: string;
}

export interface Measurement {
  task_id: string;
  versions: PinnedVersions;
  cost_usd: number;
  p50_ms: number;
  p95_ms: number;
}

export interface Thresholds {
  /** Fractional increase tolerated before a measurement counts as a regression. */
  cost: number;
  latency: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { cost: 0.2, latency: 0.25 };

export type RegressionOutcome = 'ok' | 'regressed' | 'improved' | 'rebaselined' | 'no_baseline';

export interface RegressionVerdict {
  task_id: string;
  outcome: RegressionOutcome;
  detail: string;
  cost_delta: number | null;
  p95_delta: number | null;
}

export function versionKey(versions: PinnedVersions): string {
  return `${versions.model_route}|${versions.prompt_version}|${versions.policy_version}`;
}

/** Baselines, keyed by `(task, version tuple)`. In-memory here; durable in a deployment. */
export class BaselineStore {
  readonly #rows = new Map<string, Measurement>();

  static key(taskId: string, versions: PinnedVersions): string {
    return `${taskId}@${versionKey(versions)}`;
  }

  record(measurement: Measurement): void {
    this.#rows.set(BaselineStore.key(measurement.task_id, measurement.versions), measurement);
  }

  get(taskId: string, versions: PinnedVersions): Measurement | null {
    return this.#rows.get(BaselineStore.key(taskId, versions)) ?? null;
  }

  /** Any baseline for this task, whatever the version. Used to detect a rebaseline. */
  anyFor(taskId: string): Measurement | null {
    for (const row of this.#rows.values()) {
      if (row.task_id === taskId) return row;
    }
    return null;
  }
}

export function compareToBaseline(
  current: Measurement,
  baselines: BaselineStore,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): RegressionVerdict {
  const exact = baselines.get(current.task_id, current.versions);

  if (exact === null) {
    const other = baselines.anyFor(current.task_id);
    if (other === null) {
      return {
        task_id: current.task_id,
        outcome: 'no_baseline',
        detail: 'no baseline for this task; recorded, not compared',
        cost_delta: null,
        p95_delta: null,
      };
    }
    // Same task, different pinned versions. A deliberate change, so the numbers are reported
    // and not judged — but the change itself is named, because a silent rebaseline is how a
    // cost increase gets absorbed.
    return {
      task_id: current.task_id,
      outcome: 'rebaselined',
      detail:
        `pinned versions changed (${versionKey(other.versions)} -> ${versionKey(current.versions)}); ` +
        `cost ${other.cost_usd} -> ${current.cost_usd}, p95 ${other.p95_ms}ms -> ${current.p95_ms}ms`,
      cost_delta: fraction(current.cost_usd, other.cost_usd),
      p95_delta: fraction(current.p95_ms, other.p95_ms),
    };
  }

  const costDelta = fraction(current.cost_usd, exact.cost_usd);
  const latencyDelta = fraction(current.p95_ms, exact.p95_ms);
  const breached: string[] = [];
  if (costDelta > thresholds.cost) breached.push(`cost +${percent(costDelta)}`);
  if (latencyDelta > thresholds.latency) breached.push(`p95 +${percent(latencyDelta)}`);

  if (breached.length > 0) {
    return {
      task_id: current.task_id,
      outcome: 'regressed',
      detail: `${breached.join(', ')} against the baseline at ${versionKey(current.versions)}`,
      cost_delta: costDelta,
      p95_delta: latencyDelta,
    };
  }

  const improved = costDelta <= -thresholds.cost || latencyDelta <= -thresholds.latency;
  return {
    task_id: current.task_id,
    outcome: improved ? 'improved' : 'ok',
    detail: `cost ${percent(costDelta)}, p95 ${percent(latencyDelta)} against baseline`,
    cost_delta: costDelta,
    p95_delta: latencyDelta,
  };
}

/** Relative change. A zero baseline cannot be improved on proportionally, so it is not compared. */
function fraction(current: number, baseline: number): number {
  if (baseline === 0) return current === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (current - baseline) / baseline;
}

function percent(value: number): string {
  if (!Number.isFinite(value)) return 'infinite';
  return `${(value * 100).toFixed(1)}%`;
}
