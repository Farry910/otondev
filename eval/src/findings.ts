/**
 * What the harness produces, and how it decides the build.
 *
 * The S19 exit criterion that shapes this whole package is the last one: *the harness **fails
 * the build** on a safety regression rather than reporting it.* W0 shipped a conformance
 * runner and a fake-parity driver that print. Printing is what a report does; a gate returns
 * an exit code. The difference between the two is this file.
 *
 * Three statuses and three severities, kept separate on purpose:
 *
 *   - **status** is what happened — it passed, it failed, or it could not be run.
 *   - **severity** is what it means — a safety property, a correctness property, or a
 *     quality signal.
 *
 * Collapsing them is the mistake that makes a harness lie. "Could not run" is not a pass, and
 * a failing cost benchmark is not a safety incident. Both distinctions are load-bearing:
 * without the first the harness goes green when it is broken, and without the second every
 * flaky latency number becomes a reason to bypass the safety gate.
 */

export const SEVERITIES = ['safety', 'correctness', 'quality'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CHECK_STATUSES = ['pass', 'fail', 'unavailable'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface Finding {
  /** Stable identifier: `<suite>/<case>`. Used to diff one run against another. */
  id: string;
  suite: string;
  case: string;
  status: CheckStatus;
  severity: Severity;
  /** Required whenever the status is not `pass`. A failure with no reason is not reportable. */
  detail: string | null;
  /** Which card's exit criterion this speaks to, when it speaks to one. */
  criterion: string | null;
}

export interface HarnessReport {
  findings: readonly Finding[];
  /** True only when nothing failed. Unavailable checks do not make a run green. */
  clean: boolean;
  /** The one that decides CI. */
  safetyRegressions: readonly Finding[];
  unavailable: readonly Finding[];
  counts: Record<CheckStatus, number>;
}

export function finding(
  suite: string,
  name: string,
  status: CheckStatus,
  severity: Severity,
  detail: string | null = null,
  criterion: string | null = null,
): Finding {
  return {
    id: `${suite}/${name}`,
    suite,
    case: name,
    status,
    severity,
    // A non-pass with no detail is indistinguishable from a shrug. Supply something rather
    // than emit a finding nobody can act on.
    detail: status === 'pass' ? detail : (detail ?? 'no detail recorded'),
    criterion,
  };
}

export function summarise(findings: readonly Finding[]): HarnessReport {
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, unavailable: 0 };
  for (const item of findings) counts[item.status] += 1;

  return {
    findings,
    clean: counts.fail === 0,
    safetyRegressions: findings.filter((f) => f.status === 'fail' && f.severity === 'safety'),
    unavailable: findings.filter((f) => f.status === 'unavailable'),
    counts,
  };
}

/**
 * The build decision.
 *
 * A safety failure fails the build. So does a correctness failure — a harness that let a
 * broken contract through while blocking on prompt injection would be enforcing the rarer
 * risk and waving through the common one.
 *
 * A **quality** failure does not fail the build, and an **unavailable** check does not
 * either. Both are deliberate, and they are the two decisions most likely to be argued with,
 * so the reasoning is here rather than in a commit message:
 *
 *   - Quality (cost, latency, benchmark scores) moves for reasons outside the change under
 *     test. A gate that blocks on it gets bypassed within a week, and a bypassed gate
 *     protects nothing — including the safety checks sharing its exit code.
 *   - Unavailable means the harness could not answer. Failing the build on it would make
 *     every unimplemented package a red build, and the response to a permanently red build is
 *     to stop reading it. It is reported loudly instead, and it is never counted as a pass.
 */
export function exitCodeFor(report: HarnessReport): number {
  const blocking = report.findings.filter(
    (f) => f.status === 'fail' && (f.severity === 'safety' || f.severity === 'correctness'),
  );
  return blocking.length > 0 ? 1 : 0;
}

export function formatReport(report: HarnessReport): string {
  const lines: string[] = [];
  const bySuite = new Map<string, Finding[]>();
  for (const item of report.findings) {
    bySuite.set(item.suite, [...(bySuite.get(item.suite) ?? []), item]);
  }

  for (const [suite, items] of bySuite) {
    lines.push(`${suite}`);
    for (const item of items) {
      const mark = item.status === 'pass' ? 'PASS' : item.status === 'fail' ? 'FAIL' : 'N/A ';
      const tag = item.status === 'pass' ? '' : `  [${item.severity}]`;
      lines.push(`  ${mark}  ${item.case}${tag}${item.detail === null ? '' : ` - ${item.detail}`}`);
    }
    lines.push('');
  }

  lines.push('-'.repeat(72));
  lines.push(
    `${report.counts.pass} passed, ${report.counts.fail} failed, ${report.counts.unavailable} could not run`,
  );
  if (report.safetyRegressions.length > 0) {
    lines.push('');
    lines.push(`SAFETY REGRESSION - ${report.safetyRegressions.length} finding(s). This fails the build.`);
    for (const item of report.safetyRegressions) lines.push(`  ${item.id}: ${item.detail ?? ''}`);
  }
  if (report.unavailable.length > 0) {
    lines.push('');
    lines.push(`${report.unavailable.length} check(s) could not run. Not counted as passes.`);
  }
  return lines.join('\n');
}
