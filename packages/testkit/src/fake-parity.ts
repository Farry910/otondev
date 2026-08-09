import type { ConformanceSuite } from '@otondev/contracts';
import { runConformanceSuite } from './conformance.js';
import type { CaseStatus, ConformanceReport, RunOptions, SubjectUnderTest } from './conformance.js';

/**
 * The fake-parity driver.
 *
 * Implementation-plan §1: "Fakes that are not parity-tested rot within days and silently
 * destroy the parallelism they were meant to create." This is the thing that stops that.
 *
 * It runs one suite against both the fake and the real implementation and compares
 * case-by-case. The asymmetry is the point:
 *
 *   - fake passes, real fails  -> `fake_ahead`. The dangerous one. Every session that built
 *     against the fake built against a promise the implementation does not keep, and they do
 *     not find out until integration.
 *   - fake fails, real passes  -> `fake_behind`. Cheaper, but it makes downstream sessions
 *     work around a defect that is not really there.
 *   - either one skips a case the other runs -> also a divergence. A fake that quietly
 *     declines to implement half the contract is exactly the fake this driver exists to catch.
 */

export type ParityVerdict = 'match' | 'fake_ahead' | 'fake_behind' | 'coverage_mismatch';

export interface ParityRow {
  case: string;
  fake: CaseStatus | 'absent';
  real: CaseStatus | 'absent';
  verdict: ParityVerdict;
}

export interface ParityReport {
  suite: string;
  rows: ParityRow[];
  divergences: ParityRow[];
  fake: ConformanceReport;
  /** Null while the real implementation does not exist yet — the normal state in Wave 0. */
  real: ConformanceReport | null;
  /**
   * True when the fake passes every case and, if a real implementation was supplied, the two
   * agree everywhere. A fake that fails its own suite is not "not yet compared" — it is
   * broken, and downstream sessions must not build on it.
   */
  ok: boolean;
}

export interface FakeParityInput<S> {
  suite: ConformanceSuite<S>;
  fake: SubjectUnderTest<S>;
  /** Omit until the implementation exists. The report says so rather than pretending. */
  real?: SubjectUnderTest<S>;
  options?: RunOptions;
}

function statusOf(report: ConformanceReport | null, name: string): CaseStatus | 'absent' {
  const hit = report?.results.find((r) => r.name === name);
  return hit?.status ?? 'absent';
}

function verdictFor(fake: CaseStatus | 'absent', real: CaseStatus | 'absent'): ParityVerdict {
  if (fake === real) return 'match';
  if (fake === 'skipped' || real === 'skipped' || fake === 'absent' || real === 'absent') {
    return 'coverage_mismatch';
  }
  return fake === 'pass' ? 'fake_ahead' : 'fake_behind';
}

export async function runFakeParity<S>(input: FakeParityInput<S>): Promise<ParityReport> {
  const fakeReport = await runConformanceSuite(input.suite, input.fake, input.options);
  const realReport =
    input.real === undefined ? null : await runConformanceSuite(input.suite, input.real, input.options);

  const rows: ParityRow[] = input.suite.cases.map((testCase) => {
    const fake = statusOf(fakeReport, testCase.name);
    const real = realReport === null ? 'absent' : statusOf(realReport, testCase.name);
    return {
      case: testCase.name,
      fake,
      real,
      verdict: realReport === null ? 'match' : verdictFor(fake, real),
    };
  });

  const divergences = rows.filter((r) => r.verdict !== 'match');
  return {
    suite: input.suite.name,
    rows,
    divergences,
    fake: fakeReport,
    real: realReport,
    ok: fakeReport.complete && divergences.length === 0 && (realReport === null || realReport.complete),
  };
}

export function formatParityReport(report: ParityReport): string {
  const width = Math.max(12, ...report.rows.map((r) => r.case.length));
  const lines: string[] = [
    `fake parity — ${report.suite}`,
    `${'case'.padEnd(width)}  fake      real      verdict`,
    `${'-'.repeat(width)}  --------  --------  --------`,
  ];
  for (const row of report.rows) {
    lines.push(`${row.case.padEnd(width)}  ${row.fake.padEnd(8)}  ${row.real.padEnd(8)}  ${row.verdict}`);
  }
  lines.push('');
  if (report.real === null) {
    lines.push('No real implementation supplied — this is a fake-only run. Parity is UNPROVEN.');
  }
  if (report.divergences.length > 0) {
    lines.push(`${report.divergences.length} divergence(s):`);
    for (const row of report.divergences) {
      const detail =
        row.verdict === 'fake_ahead'
          ? 'the fake promises behaviour the implementation does not deliver'
          : row.verdict === 'fake_behind'
            ? 'the fake is more restrictive than the implementation'
            : 'one side did not run this case at all';
      lines.push(`  ${row.case}: ${detail}`);
    }
  }
  for (const [label, sub] of [
    ['fake', report.fake],
    ['real', report.real],
  ] as const) {
    if (sub === null) continue;
    for (const result of sub.results) {
      if (result.status === 'fail') lines.push(`  ${label} FAIL ${result.name} — ${result.reason ?? ''}`);
      if (result.status === 'skipped') lines.push(`  ${label} SKIP ${result.name} — ${result.reason ?? ''}`);
    }
  }
  lines.push(report.ok ? 'PARITY OK' : 'PARITY NOT ESTABLISHED');
  return lines.join('\n');
}
