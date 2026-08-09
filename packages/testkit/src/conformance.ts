import type { ConformanceContext, ConformanceSuite } from '@otondev/contracts';
export type { ConformanceCase, ConformanceContext, ConformanceSuite } from '@otondev/contracts';
export { defineConformanceSuite, expectEqual, expectRejection, expectTrue } from '@otondev/contracts';
import { FakeClock } from './clock.js';
import { deterministicIdFactory } from './ids.js';
import { FaultInjector } from './faults.js';

/**
 * The conformance runner.
 *
 * Property 4 of an independently buildable package (implementation-plan §1) is the one the
 * whole plan rests on: a package "ships a fake of itself that passes the same conformance
 * suite as the real one". That is what lets the session building the Connector Broker trust
 * the Policy fake without reading Policy's source, and what keeps the trust valid after
 * Policy is rewritten.
 *
 * "The same suite" has to be literal. A suite written twice — once against the fake, once
 * against the implementation — diverges within a week and then guarantees nothing. So a
 * suite is a value declared once (in `@otondev/sdk`, next to the interface) and run here
 * against whichever subject you hand it.
 */

export type CaseStatus = 'pass' | 'fail' | 'skipped';

export interface CaseResult {
  name: string;
  status: CaseStatus;
  /** Present for `fail` and for `skipped`. A skip without a reason is not reportable. */
  reason: string | null;
  durationMs: number;
}

export interface ConformanceReport {
  suite: string;
  subject: string;
  results: CaseResult[];
  passed: number;
  failed: number;
  skipped: number;
  /** True only when nothing failed *and* nothing was skipped. */
  complete: boolean;
}

export interface SubjectUnderTest<S> {
  name: string;
  /** Fresh per case. Shared state between cases hides ordering bugs in the subject. */
  create(context: ConformanceContext): S | Promise<S>;
  /** What this subject supports, matched against each case's `requires`. */
  capabilities?: readonly string[];
  teardown?(subject: S): void | Promise<void>;
}

export interface RunOptions {
  /** Milliseconds before a case is failed as hung. A hang must not become a CI timeout. */
  caseTimeoutMs?: number;
  /** Fixed start time, so two runs of one suite produce identical ids and timestamps. */
  startTime?: string;
}

export function createConformanceContext(startTime: string, seed: number): ConformanceContext {
  const clock = new FakeClock(startTime);
  const faults = new FaultInjector({ clock, advance: (ms) => clock.advance(ms) });
  return {
    clock,
    ids: deterministicIdFactory({ clock, seed }),
    faults,
    advance: (ms) => clock.advance(ms),
  };
}

async function withTimeout(promise: Promise<void>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`case "${label}" did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runConformanceSuite<S>(
  suite: ConformanceSuite<S>,
  subject: SubjectUnderTest<S>,
  options: RunOptions = {},
): Promise<ConformanceReport> {
  const caseTimeoutMs = options.caseTimeoutMs ?? 5_000;
  const startTime = options.startTime ?? '2026-07-30T08:00:00.000Z';
  const capabilities = new Set(subject.capabilities ?? []);
  const results: CaseResult[] = [];

  for (const [index, testCase] of suite.cases.entries()) {
    const missing = (testCase.requires ?? []).filter((capability) => !capabilities.has(capability));
    if (missing.length > 0) {
      results.push({
        name: testCase.name,
        status: 'skipped',
        reason: `subject does not declare: ${missing.join(', ')}`,
        durationMs: 0,
      });
      continue;
    }

    const context = createConformanceContext(startTime, index + 1);
    const startedAt = performance.now();
    let instance: S | undefined;
    try {
      instance = await subject.create(context);
      await withTimeout(Promise.resolve(testCase.run(instance, context)), caseTimeoutMs, testCase.name);
      results.push({
        name: testCase.name,
        status: 'pass',
        reason: null,
        durationMs: performance.now() - startedAt,
      });
    } catch (error) {
      results.push({
        name: testCase.name,
        status: 'fail',
        reason: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - startedAt,
      });
    } finally {
      if (instance !== undefined && subject.teardown !== undefined) {
        try {
          await subject.teardown(instance);
        } catch {
          // A teardown failure must not rewrite the case's verdict.
        }
      }
    }
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  return {
    suite: suite.name,
    subject: subject.name,
    results,
    passed,
    failed,
    skipped,
    complete: failed === 0 && skipped === 0,
  };
}

export function formatConformanceReport(report: ConformanceReport): string {
  const lines = [`${report.suite} against ${report.subject}`];
  for (const result of report.results) {
    const mark = result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : 'SKIP';
    lines.push(`  ${mark}  ${result.name}${result.reason === null ? '' : ` — ${result.reason}`}`);
  }
  lines.push(`  ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);
  return lines.join('\n');
}
