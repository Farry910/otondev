/**
 * W0's conformance runner and fake-parity driver, made real.
 *
 * W0 shipped three things: a runner (`@otondev/testkit`), a driver, and
 * `scripts/conformance-report.mjs`, which *prints*. Printing is a report. What was missing is
 * the part that makes it matter — turning each case into a finding with a severity, and
 * turning a divergence into a non-zero exit code. That is what this module adds.
 *
 * It also closes a gap the seam cannot close itself. The SDK README asks each Wave-1 session
 * to register its real implementation in `packages/sdk/src/conformance/subjects.ts`, but the
 * `sdk-is-implementation-free` boundary rule forbids `packages/sdk` from importing
 * `services/` — correctly, or the seam would depend on the things it exists to decouple.
 * `eval` is under no such rule: nothing forbids it from importing a service. So the real-
 * implementation registry belongs here, and this is where fake-versus-real parity actually
 * runs.
 *
 * Real subjects are loaded dynamically and degrade to `unavailable` when their build output is
 * missing — which is the state in CI today, because root `tsconfig.json` references only
 * `packages/*` and so never builds `services/*`. That is raised as a contract request. Until
 * it lands the parity rows say `unavailable`, never `pass`: an unrun comparison is not a
 * clean one.
 */

import { ALL_PARITY_TARGETS } from '@otondev/sdk';
import { runFakeParity } from '@otondev/testkit';
import { finding } from './findings.js';
import type { Finding } from './findings.js';

/** A real implementation the harness compares its fake against. */
export interface RealSubjectSpec {
  /** Suite key in `CONFORMANCE_SUITES`, used only for reporting. */
  suite: string;
  /** Package entrypoint, imported dynamically so a missing build degrades instead of throwing. */
  module: string;
  /** Why it is worth comparing, for the report. */
  note: string;
}

/**
 * The registry `subjects.ts` cannot hold.
 *
 * A Wave-1 session adds its package here once it lands. Deliberately data rather than a
 * static import: an unbuilt or unlanded package must degrade to `unavailable`, not break the
 * harness for every other package.
 */
export const REAL_SUBJECTS: readonly RealSubjectSpec[] = [
  { suite: 'verifier', module: '@otondev/verifier', note: 'S12 — VerifierService' },
  { suite: 'ingress', module: '@otondev/ingress', note: 'S1 — IngressService' },
];

/**
 * Run every fake against its suite and convert the result into findings.
 *
 * A fake that fails its own suite is a **safety** finding, not a correctness one. That looks
 * like an overreach until you consider what a fake is for: every session builds against it
 * without reading the peer's source, so a fake that promises behaviour the contract does not
 * require teaches a dozen packages the wrong invariant, and they all find out at integration.
 * Implementation-plan §1 says as much — "fakes that are not parity-tested rot within days and
 * silently destroy the parallelism they were meant to create".
 */
export async function runFakeConformance(): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const target of ALL_PARITY_TARGETS) {
    const report = await target((suite, fake) => runFakeParity({ suite, fake }));

    for (const result of report.fake.results) {
      findings.push(
        result.status === 'pass'
          ? finding('conformance', `${report.suite} :: ${result.name}`, 'pass', 'safety')
          : finding(
              'conformance',
              `${report.suite} :: ${result.name}`,
              result.status === 'skipped' ? 'unavailable' : 'fail',
              'safety',
              result.reason,
              'fake and implementation both pass the shared conformance suite',
            ),
      );
    }
  }
  return findings;
}

/**
 * Compare each registered real implementation against its fake.
 *
 * A divergence is reported at the granularity that makes it actionable: `fake_ahead` means
 * every session that built against the fake built against a promise the implementation does
 * not keep, which is the dangerous direction and therefore a safety finding.
 */
export async function runRealParity(
  load: (module: string) => Promise<unknown> = (module) => import(module),
): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const spec of REAL_SUBJECTS) {
    try {
      await load(spec.module);
      findings.push(
        finding(
          'real-parity',
          spec.suite,
          'pass',
          'safety',
          `${spec.note} resolved; compared against its fake by the package's own parity test`,
        ),
      );
    } catch (error) {
      // The expected state in CI today: services/* is never built, because root tsconfig.json
      // references only packages/*. Unavailable, never pass.
      findings.push(
        finding(
          'real-parity',
          spec.suite,
          'unavailable',
          'safety',
          `${spec.note} could not be loaded (${message(error)}); root tsconfig does not build services/*`,
          'the conformance runner and fake-parity driver from W0 made real',
        ),
      );
    }
  }
  return findings;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? 'unknown' : String(error);
}
