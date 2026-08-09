/**
 * Out-of-order source versions: retained, but never rolling state backward.
 *
 * Contracts §2 and the S1 exit criterion are precise about the two halves, and they pull in
 * opposite directions:
 *
 *   - **retained** — a late event is still a real event. Dropping it loses information, and
 *     "we never saw it" is indistinguishable from "we saw it and ignored it" afterwards.
 *   - **does not roll state backward** — but it must not overwrite what a newer event already
 *     established.
 *
 * So a late delivery is accepted, stored and enqueued like any other, and separately marked
 * `superseded` in the ingress ledger. Downstream reads the mark; nothing is deleted.
 *
 * `EventSubject.version` is "the source system's version of the subject, as a string: sources
 * are not consistent". Which means comparison can fail, and the failure has to be safe.
 */

export type VersionOrder = 'newer' | 'same' | 'older' | 'unorderable';

const NUMERIC = /^[0-9]+$/;
const DOTTED = /^[0-9]+(\.[0-9]+)*$/;

/**
 * Compare two source versions.
 *
 * Handles the two shapes sources actually use — a monotonic integer and a dotted sequence —
 * and refuses everything else. It deliberately does **not** fall back to lexicographic
 * ordering: `"10"` sorts before `"9"` as text, so a lexicographic fallback would silently
 * classify a newer event as older, which is the exact failure this module exists to prevent.
 */
export function compareVersions(incoming: string, known: string): VersionOrder {
  if (incoming === known) return 'same';

  if (NUMERIC.test(incoming) && NUMERIC.test(known)) {
    const a = Number(incoming);
    const b = Number(known);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return 'unorderable';
    return a > b ? 'newer' : 'older';
  }

  if (DOTTED.test(incoming) && DOTTED.test(known)) {
    const a = incoming.split('.').map(Number);
    const b = known.split('.').map(Number);
    const width = Math.max(a.length, b.length);
    for (let index = 0; index < width; index += 1) {
      const left = a[index] ?? 0;
      const right = b[index] ?? 0;
      if (left !== right) return left > right ? 'newer' : 'older';
    }
    return 'same';
  }

  // Two versions of different shapes, or a shape this build does not understand. Saying
  // "unorderable" costs an unnecessary `superseded` mark; guessing costs correctness.
  return 'unorderable';
}

export type VersionVerdict = 'current' | 'superseded';

export interface SubjectVersionState {
  subject_key: string;
  /** The highest version seen. Only ever advances. */
  high_water: string;
  observed_at: string;
}

/**
 * The high-water mark per subject.
 *
 * Keyed by `(tenant, system, installation, subject type, subject id)` — the same granularity
 * as the dedupe key plus the subject, because two installations of one system can be two
 * different tenants' data and must never share a watermark.
 */
export class SubjectVersionLedger {
  readonly #state = new Map<string, SubjectVersionState>();

  static key(parts: {
    tenant_id: string;
    system: string;
    installation_id: string;
    subject_type: string;
    subject_id: string;
  }): string {
    return [parts.tenant_id, parts.system, parts.installation_id, parts.subject_type, parts.subject_id].join(':');
  }

  /**
   * Record an observation and say whether it advanced the subject.
   *
   * `unorderable` returns `superseded` and leaves the watermark alone: an event we cannot
   * place must not be allowed to move the mark, in either direction.
   */
  observe(subjectKey: string, version: string, at: string): VersionVerdict {
    const known = this.#state.get(subjectKey);
    if (known === undefined) {
      this.#state.set(subjectKey, { subject_key: subjectKey, high_water: version, observed_at: at });
      return 'current';
    }

    const order = compareVersions(version, known.high_water);
    if (order === 'newer') {
      this.#state.set(subjectKey, { subject_key: subjectKey, high_water: version, observed_at: at });
      return 'current';
    }
    return 'superseded';
  }

  highWater(subjectKey: string): string | null {
    return this.#state.get(subjectKey)?.high_water ?? null;
  }
}
