import { describe, expect, it } from 'vitest';
import { CONFORMANCE_SUITES, createFakeRegistry } from '@otondev/sdk';
import type { VerifierClient } from '@otondev/sdk';
import { deterministicIdFactory } from '@otondev/testkit';
import type { ConformanceContext } from '@otondev/testkit';
import { formatConformanceReport, runConformanceSuite, runFakeParity } from '@otondev/testkit';
import { VerifierService } from './verifier.js';
import { StubManifestSource, LIMITS, ScriptedRunner, ScriptedScanner, WORKER_IMAGE } from './testing/harness.js';

/**
 * The shared conformance suite, run against the real implementation.
 *
 * ## Why this lives here and not in `packages/sdk/src/conformance/subjects.ts`
 *
 * The SDK README tells a Wave-1 session to "add `real:` to your entry in
 * `src/conformance/subjects.ts`". That instruction cannot be followed: `subjects.ts` is in
 * `packages/sdk`, and the `sdk-is-implementation-free` boundary rule forbids anything under
 * `packages/sdk/` from importing `services/`. Wiring `real:` there fails the boundary cruise,
 * which is the correct outcome — the seam must not depend on an implementation, or it stops
 * being the thing that lets twenty sessions build at once.
 *
 * So the parity comparison runs from the implementation's own package, which may import the
 * SDK freely. The property the exit criterion asks for — *the same* suite, one declaration,
 * run against both subjects — is preserved exactly: `CONFORMANCE_SUITES.verifier` is imported,
 * never restated. What is lost is only the `node scripts/conformance-report.mjs` roll-up,
 * which still reports this suite as UNPROVEN. Raised as a contract request; see the card log.
 */

function realVerifier(context: ConformanceContext): VerifierClient {
  const { services } = createFakeRegistry({ clock: context.clock, ids: context.ids });
  return new VerifierService({
    workspace: services.workspace,
    evidence: services.evidence,
    clock: context.clock,
    ids: context.ids,
    manifests: new StubManifestSource(),
    runner: new ScriptedRunner(),
    scanners: [new ScriptedScanner('secret'), new ScriptedScanner('diff'), new ScriptedScanner('licence')],
    config: { verifierVersion: 'verifier-v3', workerImage: WORKER_IMAGE, limits: LIMITS },
  });
}

function fakeVerifier(context: ConformanceContext): VerifierClient {
  return createFakeRegistry({ clock: context.clock, ids: context.ids }).services.verifier;
}

describe('shared conformance suite', () => {
  it('the real implementation passes it', async () => {
    const report = await runConformanceSuite(CONFORMANCE_SUITES.verifier, {
      name: 'VerifierService',
      create: realVerifier,
    });

    // `complete` is stricter than "nothing failed": a skipped case is not a pass, which is
    // the same rule the subject under test is being examined for.
    expect(formatConformanceReport(report)).toContain('0 failed');
    expect(report.complete).toBe(true);
  });

  it('the fake passes it too, and the two agree case by case', async () => {
    const report = await runFakeParity({
      suite: CONFORMANCE_SUITES.verifier,
      fake: { name: 'FakeVerifier', create: fakeVerifier },
      real: { name: 'VerifierService', create: realVerifier },
    });

    // A divergence here is the failure mode the whole fake-parity idea exists to catch: every
    // session that built against the fake built against a promise the implementation does not
    // keep, and nobody finds out until integration.
    expect(report.divergences).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('runs every case the suite declares, so parity is not vacuous', async () => {
    const report = await runFakeParity({
      suite: CONFORMANCE_SUITES.verifier,
      fake: { name: 'FakeVerifier', create: fakeVerifier },
      real: { name: 'VerifierService', create: realVerifier },
    });

    expect(report.rows.length).toBe(CONFORMANCE_SUITES.verifier.cases.length);
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows.every((row) => row.fake === 'pass' && row.real === 'pass')).toBe(true);
  });
});

describe('the control-hook suite', () => {
  it('the real implementation satisfies the W0-E hooks', async () => {
    const report = await runConformanceSuite(CONFORMANCE_SUITES.controlHooks, {
      name: 'VerifierService',
      create: realVerifier,
    });

    expect(formatConformanceReport(report)).toContain('0 failed');
    expect(report.complete).toBe(true);
  });

  it('matches the fake on the hooks as well', async () => {
    const report = await runFakeParity({
      suite: CONFORMANCE_SUITES.controlHooks,
      fake: { name: 'FakeVerifier', create: fakeVerifier },
      real: { name: 'VerifierService', create: realVerifier },
    });

    expect(report.divergences).toEqual([]);
  });
});

describe('determinism', () => {
  it('two runs of the suite produce the same report', async () => {
    // Same inputs, same ids, same timestamps — what makes an evidence digest worth comparing.
    const once = await runConformanceSuite(CONFORMANCE_SUITES.verifier, { name: 'a', create: realVerifier });
    const twice = await runConformanceSuite(CONFORMANCE_SUITES.verifier, { name: 'a', create: realVerifier });

    expect(once.results.map((r) => [r.name, r.status])).toEqual(twice.results.map((r) => [r.name, r.status]));
  });

  it('produces identical verdicts across two independent runs', async () => {
    const clock = { nowMs: () => 0, nowIso: () => '2026-07-30T08:00:00Z' };
    const verdicts = [];

    for (const seed of [7, 7]) {
      const ids = deterministicIdFactory({ clock, seed });
      const { services } = createFakeRegistry({ clock, ids });
      const verifier = new VerifierService({
        workspace: services.workspace,
        evidence: services.evidence,
        clock,
        ids,
        manifests: new StubManifestSource(),
        runner: new ScriptedRunner(),
        scanners: [new ScriptedScanner('secret')],
        config: { verifierVersion: 'verifier-v3', workerImage: WORKER_IMAGE, limits: LIMITS },
      });
      verdicts.push(
        await verifier.verify({
          workflow_id: 'wf_01JQ0000000000000000000000',
          goal_digest: `sha256:${'e'.repeat(64)}`,
          diff_digest: `sha256:${'c'.repeat(64)}`,
          head_sha: 'a'.repeat(40),
          definition_of_done_ref: 'dod_default_v1',
          manifest_version: 'verifier-v3',
          evidence_refs: [],
        }),
      );
    }

    // Same seed, same injected clock, same verdict — including `completed_at`. A verifier
    // that read the wall clock internally could not make this assertion at all.
    expect(verdicts[0]).toEqual(verdicts[1]);
  });
});
