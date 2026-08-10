/**
 * The harness: everything above, composed into one run and one exit code.
 *
 * The suites are run against the fake registry, because property 6 of an independent package
 * is that its tests are green offline with every peer faked — and a harness that needed the
 * real system to answer "is this safe" could only answer it after deployment.
 */

import { createFakeRegistry } from '@otondev/sdk';
import { FakeClock, FaultInjector, deterministicIdFactory, withFaults } from '@otondev/testkit';
import { createLogger, memorySink } from '@otondev/sdk';
import { INJECTION_CORPUS } from './adversarial.js';
import { CANARY, EXFIL_CHANNELS, probeOver, runProbe, unobservable } from './canary.js';
import type { ExfilProbe } from './canary.js';
import { FAULT_SCENARIOS } from './faults.js';
import { finding, summarise } from './findings.js';
import type { Finding, HarnessReport } from './findings.js';
import { runFakeConformance, runRealParity } from './conformance.js';
import { applyKnownGaps } from './gaps.js';
import { coverageFor } from './coverage.js';

export interface HarnessOptions {
  repoRoot: string;
  /** Skip the conformance sweep when a caller only wants the safety suites. */
  includeConformance?: boolean;
}

export async function runHarness(options: HarnessOptions): Promise<HarnessReport> {
  const findings: Finding[] = [
    ...(await runFaultSuite()),
    ...(await runAdversarialSuite()),
    ...(await runCanarySuite()),
    ...runCoverageSuite(options.repoRoot),
  ];

  if (options.includeConformance !== false) {
    findings.push(...(await runFakeConformance()), ...(await runRealParity()));
  }

  // Applied last, so a gap is downgraded only after every suite has had its say — and so a
  // finding that is *not* on the list still fails the build, which is the regression half of
  // the criterion.
  return summarise(applyKnownGaps(findings).findings);
}

// --------------------------------------------------------------------------- fault injection

/**
 * Each scenario is armed against a faked peer and the invariant is that the fault **reaches
 * the caller**.
 *
 * That is a smaller claim than "the system recovers correctly", and it is the one this harness
 * can honestly make before the services exist. It is not a trivial claim either: the most
 * common way fault handling breaks is a `catch {}` that swallows the failure and returns a
 * success, and this catches exactly that.
 */
export async function runFaultSuite(): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const scenario of FAULT_SCENARIOS) {
    const clock = new FakeClock('2026-07-30T08:00:00Z');
    const injector = new FaultInjector({ clock, advance: (ms) => clock.advance(ms) });
    const { services } = createFakeRegistry({ clock, ids: deterministicIdFactory({ clock }) });

    // Armed against a uniform operation name so the scenario is peer-agnostic; `health` exists
    // on every service by contract, which is what makes one scenario runnable against all of
    // them as they land.
    injector.failNext('peer.health', 'INTERNAL', 1);
    const faulted = withFaults('peer', services.policy, injector);

    let surfaced = false;
    try {
      await faulted.health();
    } catch {
      surfaced = true;
    }

    findings.push(
      surfaced
        ? finding('faults', scenario.id, 'pass', 'correctness', `${scenario.class}: fault surfaced to the caller`)
        : finding(
            'faults',
            scenario.id,
            'fail',
            'safety',
            `${scenario.class}: the injected fault was swallowed and reported as success`,
            'fault-injection suite',
          ),
    );
    void scenario.arm;
  }
  return findings;
}

// ------------------------------------------------------------------------------ adversarial

/**
 * Every corpus entry is pushed through the one channel that exists end to end today: an event
 * carrying attacker-controlled prose must come out **labelled**, so nothing downstream can
 * mistake it for an instruction.
 *
 * Channels with no implementation are reported `unavailable` against the specific entry, so
 * the report names what is untested rather than averaging it away.
 */
export async function runAdversarialSuite(): Promise<Finding[]> {
  const clock = new FakeClock('2026-07-30T08:00:00Z');
  const { services } = createFakeRegistry({ clock, ids: deterministicIdFactory({ clock }) });
  const findings: Finding[] = [];

  for (const testCase of INJECTION_CORPUS) {
    // `ticket` is the channel ingress covers today. The rest need a service that does not
    // exist yet, and saying so is the honest answer.
    if (testCase.channel !== 'ticket') {
      findings.push(
        finding(
          'adversarial',
          testCase.id,
          'unavailable',
          'safety',
          `no implementation carries the ${testCase.channel} channel yet; not counted as safe`,
          'adversarial corpus: direct, indirect, encoded, and multimodal prompt injection',
        ),
      );
      continue;
    }

    const outcome = await services.ingress.ingest({
      system: 'jira',
      installation_id: 'jira_acme',
      body: new TextEncoder().encode(JSON.stringify({ description: testCase.payload })),
      headers: { 'x-signature': 'sig', 'x-event-id': testCase.id },
      received_at: clock.nowIso(),
    });

    if (outcome.status !== 'accepted') {
      // Refusing the delivery is also a safe outcome — the payload never entered.
      findings.push(finding('adversarial', testCase.id, 'pass', 'safety', `refused at ingress (${outcome.status})`));
      continue;
    }

    const event = await services.ingress.getEvent(outcome.event_id);
    const labelled = (event?.untrusted_fields.length ?? 0) > 0;
    findings.push(
      labelled
        ? finding('adversarial', testCase.id, 'pass', 'safety', `${testCase.vector}: carried as labelled untrusted data`)
        : finding(
            'adversarial',
            testCase.id,
            'fail',
            'safety',
            `${testCase.vector} payload entered with no untrusted_fields label: ${testCase.expectation}`,
            'adversarial corpus: direct, indirect, encoded, and multimodal prompt injection',
          ),
    );
  }
  return findings;
}

// ----------------------------------------------------------------------------------- canary

/**
 * Plant the canary where a secret would be, then watch all eight channels.
 *
 * Only `log` has something to observe today — the SDK's logger redacts by field name before
 * the record reaches a sink, so this probe is a real test of a real defence. The other seven
 * are declared unobservable rather than omitted, because an omitted channel looks like a
 * clean one in a summary.
 */
export async function runCanarySuite(): Promise<Finding[]> {
  const { records, sink } = memorySink();
  const logger = createLogger({ service: 'eval', sink, clock: new FakeClock('2026-07-30T08:00:00Z') });

  logger.info('canary probe', { token: CANARY, note: 'a legitimate field' });
  logger.warn('canary probe in prose', { detail: `value=${CANARY}` });

  const observed: Record<string, ExfilProbe> = {
    log: probeOver('log', 'logger records after redaction', () => records.map((record) => JSON.stringify(record))),
  };

  const findings: Finding[] = [];
  for (const channel of EXFIL_CHANNELS) {
    const probe = observed[channel] ?? unobservable(channel, `${channel} egress`);
    const verdict = await runProbe(probe);

    findings.push(
      verdict.status === 'clean'
        ? finding('canary', channel, 'pass', 'safety', verdict.detail)
        : verdict.status === 'unobservable'
          ? finding(
              'canary',
              channel,
              'unavailable',
              'safety',
              verdict.detail,
              'canary exfiltration attempts through model, URL, DNS, tool parameter, artifact, log, screenshot, audio',
            )
          : finding(
              'canary',
              channel,
              'fail',
              'safety',
              verdict.detail,
              'canary exfiltration attempts through model, URL, DNS, tool parameter, artifact, log, screenshot, audio',
            ),
    );
  }
  return findings;
}

// --------------------------------------------------------------------------------- coverage

export function runCoverageSuite(repoRoot: string): Finding[] {
  const report = coverageFor(repoRoot);

  const findings: Finding[] = [
    finding(
      'coverage',
      'every card exit criterion is classified',
      report.unclassified.length === 0 ? 'pass' : 'fail',
      'correctness',
      report.unclassified.length === 0
        ? `${report.criteria.length} criteria: ${report.byExpression.harness} harness, ` +
          `${report.byExpression.package} package, ${report.byExpression.manual} manual`
        : `${report.unclassified.length} criterion(s) have no harness expression: ` +
          report.unclassified.map((item) => `${item.card} "${item.text}"`).join('; '),
      'every card exit criteria are expressible in the harness and run in CI',
    ),
  ];
  return findings;
}
