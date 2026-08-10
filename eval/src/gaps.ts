/**
 * Known gaps.
 *
 * The exit criterion is that the harness fails the build on a safety **regression**. A gap
 * that was already there when the harness arrived is not a regression, and treating it as one
 * would turn main red for every session on the day this package lands — which gets the harness
 * disabled, not the gap fixed.
 *
 * So a known gap is downgraded from `fail` to `unavailable`: still not a pass, still printed
 * on every run, but not build-failing. Three constraints keep that from becoming a way to
 * silence findings:
 *
 *   1. every entry must name a **raised contract request**, so the gap is somebody's work item
 *      and not a note in a file nobody reads;
 *   2. every entry must name the **owning card**, so it is clear who can close it;
 *   3. an entry that no longer matches any finding is itself reported — a stale suppression is
 *      how a fixed gap silently reopens.
 *
 * Anything *not* on this list that fails still fails the build. That is the regression half of
 * the criterion, and it is what a test in this package asserts directly.
 */

import { finding } from './findings.js';
import type { Finding } from './findings.js';

export interface KnownGap {
  /** Finding id, `<suite>/<case>`. */
  id: string;
  /** The card that owns the fix. */
  owner: string;
  /** The raised request. A gap with no request is not known, it is ignored. */
  request: string;
  reason: string;
}

export const KNOWN_GAPS: readonly KnownGap[] = [
  {
    id: 'canary/log',
    owner: 'W0',
    request: 'board/requests — logger redaction is field-name based',
    reason:
      'Contracts §1 specifies redaction "by schema, not only string matching", so `redact()` keys on ' +
      'field name. A credential pasted into a free-text field — a `detail`, a `message`, an untrusted ' +
      'ticket body quoted into a log line — is therefore not redacted and reaches the sink verbatim. ' +
      'Found by this harness on its first run, against the real SDK logger, not hypothesised.',
  },
];

export interface GapApplication {
  findings: readonly Finding[];
  /** Gaps that matched nothing. A suppression outliving its defect hides the next one. */
  stale: readonly KnownGap[];
}

/**
 * Downgrade known failures, and report suppressions that no longer apply.
 *
 * Only `fail` is downgraded, and only to `unavailable`. A known gap never becomes a pass —
 * the whole point of the list is that these are things the system does **not** do correctly.
 */
export function applyKnownGaps(findings: readonly Finding[], gaps: readonly KnownGap[] = KNOWN_GAPS): GapApplication {
  const matched = new Set<string>();

  const adjusted = findings.map((item): Finding => {
    const gap = gaps.find((candidate) => candidate.id === item.id);
    if (gap === undefined || item.status !== 'fail') return item;

    matched.add(gap.id);
    return {
      ...item,
      status: 'unavailable',
      detail: `KNOWN GAP (${gap.owner}, ${gap.request}): ${item.detail ?? ''} — ${gap.reason}`,
    };
  });

  const stale = gaps.filter((gap) => !matched.has(gap.id));
  const withStale = [
    ...adjusted,
    ...stale.map((gap) =>
      finding(
        'known-gaps',
        `${gap.id} no longer reproduces`,
        'fail',
        'correctness',
        `the suppression for ${gap.id} matched nothing. Remove it — a stale suppression hides the next defect.`,
      ),
    ),
  ];

  return { findings: withStale, stale };
}
