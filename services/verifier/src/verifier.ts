/**
 * S12 — the Verifier.
 *
 * Runs the definition of done against the immutable diff and commit, and reports a verdict
 * plus what it could not establish. It is a separate process from the executor
 * (implementation-plan §2), which is a trust boundary rather than a deployment preference,
 * and the shape of this class is what makes the boundary real:
 *
 *   - it takes its runner and scanners as ports, so its authority is exactly what was handed
 *     to it and a test can enumerate that;
 *   - it projects its input to the seven declared fields, so the executor's narrative cannot
 *     ride along on the request object;
 *   - it has no publish, comment, approve or transition method, and a conformance case walks
 *     the object to prove it.
 *
 * Everything it cannot establish becomes a `skipped` or `unavailable` check with a reason,
 * and any of those caps the verdict at `inconclusive`. There is no path through this file
 * that turns "did not run" into "pass".
 */

import { ContractError, makeError } from '@otondev/contracts';
import type { Clock, ErrorCode, IdFactory } from '@otondev/contracts';
import { ControlState } from '@otondev/sdk';
import type {
  ControlAck,
  DenyRequest,
  HealthReport,
  QuarantineRequest,
  RevokeRequest,
  ServiceId,
  ServiceRegistry,
  VerifierClient,
  VerifierVerdict,
  VerifyInput,
} from '@otondev/sdk';
import type { ResourceLimits } from '@otondev/contracts';
import { SUPPORTED_MANIFEST_VERSIONS, isSupportedVersion, normaliseVersion, validateManifest } from './manifest.js';
import type { ForbiddenRule, ManifestCheck, VerifierManifest } from './manifest.js';
import type { CheckOutcome, CheckRunner, Scanner, ScannerKind, VerificationTarget } from './ports.js';
import { aggregateVerdict, limitationsFrom, projectVerifyInput, summarise, unavailable } from './verdict.js';

/** Where the repository's manifest document comes from. Injected: it is repository data. */
export interface ManifestSource {
  /** The manifest document for a pinned version ref, or null when the repository declares none. */
  load(versionRef: string): Promise<unknown>;
}

/**
 * Which conditional check groups apply to this workflow.
 *
 * Derived from the diff, so it is a port rather than a parameter: deciding that a change is a
 * `frontend-change` is a judgement about the diff, and the verifier must make it from the
 * diff rather than from anything the executor said about the diff.
 */
export interface ConditionEvaluator {
  conditionsFor(target: VerificationTarget): Promise<readonly string[]>;
}

export interface VerifierConfig {
  /** Pinned by digest. Lands in evidence as `verifier.version`. */
  verifierVersion: string;
  /** The image checks run in, pinned by digest — a tag is a promise, a digest is a fact. */
  workerImage: string;
  limits: ResourceLimits;
}

export interface VerifierDeps extends Pick<ServiceRegistry, 'workspace' | 'evidence'> {
  clock: Clock;
  ids: IdFactory;
  manifests: ManifestSource;
  runner: CheckRunner;
  /** Diff, secret and licence hooks. An empty list is legal and produces limitations, not passes. */
  scanners: readonly Scanner[];
  conditions?: ConditionEvaluator;
  config: VerifierConfig;
}

/** Which scanner kind answers which manifest `forbidden` rule. */
const RULE_SCANNER: Readonly<Record<ForbiddenRule, ScannerKind>> = {
  'generated-secrets': 'secret',
  'modified-protected-paths-without-approval': 'diff',
  'incompatible-licence': 'licence',
};

export class VerifierService implements VerifierClient {
  readonly serviceId = 'verifier' as const;

  readonly #deps: VerifierDeps;
  readonly #control: ControlState;
  /** Fresh workspace per attempt — reuse is what leaks state between attempts. */
  readonly #attempts = new Map<string, number>();
  /** Verifications in flight, so `quarantine` can report what it actually contained. */
  readonly #inFlight = new Set<string>();

  constructor(deps: VerifierDeps) {
    this.#deps = deps;
    this.#control = new ControlState('verifier' satisfies ServiceId, deps.clock);
  }

  // ------------------------------------------------------------------ VerifierClient

  async verify(input: VerifyInput): Promise<VerifierVerdict> {
    // Projected first, before anything reads a field. Whatever else was on the wire — an
    // executor's summary, a "please approve", a prompt — does not survive this line.
    const request = projectVerifyInput(input as unknown as Record<string, unknown>);

    // Fails closed on a manifest version it does not implement, before doing any work. Order
    // matters: provisioning a workspace for a manifest we cannot honour would be work done on
    // behalf of a request we are about to refuse.
    const version = normaliseVersion(request.manifest_version);
    if (!isSupportedVersion(version)) {
      this.#fail('VERIFY_MANIFEST_INVALID', {
        requested: request.manifest_version,
        supported: SUPPORTED_MANIFEST_VERSIONS.join(','),
      });
    }

    if (this.#control.isDenied({ kind: 'global' }) || this.#control.isDenied({ kind: 'workflow', id: request.workflow_id })) {
      this.#fail('EMERGENCY_STOP_ACTIVE', { workflow_id: request.workflow_id });
    }

    const document = await this.#deps.manifests.load(version);
    if (document === null || document === undefined) {
      this.#fail('VERIFY_MANIFEST_INVALID', { requested: version, reason: 'repository declares no manifest' });
    }

    const validation = validateManifest(document);
    if (!validation.valid || validation.manifest === null) {
      this.#fail('VERIFY_MANIFEST_INVALID', {
        requested: version,
        errors: validation.errors.join('; ').slice(0, 400),
      });
    }

    const manifest = validation.manifest;
    const target: VerificationTarget = {
      workflow_id: request.workflow_id,
      head_sha: request.head_sha,
      diff_digest: request.diff_digest,
      goal_digest: request.goal_digest,
      definition_of_done_ref: request.definition_of_done_ref,
    };

    this.#inFlight.add(request.workflow_id);
    try {
      const checks = await this.#runAll(manifest, target, request.evidence_refs);
      const verdict = aggregateVerdict(checks);
      return {
        workflow_id: request.workflow_id,
        verdict,
        checks: summarise(checks),
        limitations: limitationsFrom(checks),
        verifier_version: this.#deps.config.verifierVersion,
        completed_at: this.#deps.clock.nowIso(),
      };
    } finally {
      this.#inFlight.delete(request.workflow_id);
    }
  }

  async validateManifest(manifest: unknown): Promise<{ valid: boolean; version: string | null; errors: string[] }> {
    const result = validateManifest(manifest);
    return { valid: result.valid, version: result.version, errors: result.errors };
  }

  // ------------------------------------------------------------------ ServiceClient

  async health(): Promise<HealthReport> {
    return {
      service: this.serviceId,
      status: 'ok',
      denying: this.#control.isDenied({ kind: 'global' }),
      detail: `verifier ${this.#deps.config.verifierVersion}, ${this.#inFlight.size} in flight`,
      checked_at: this.#deps.clock.nowIso(),
    };
  }

  async deny(request: DenyRequest): Promise<ControlAck> {
    this.#control.recordDeny(request);
    // New verifications only. One already running is contained by `quarantine`, and
    // conflating the two would let an operator believe a deny had stopped a run in progress.
    return this.#control.ack('contained', ['verifier:new-verifications']);
  }

  async quarantine(request: QuarantineRequest): Promise<ControlAck> {
    const scopeId = request.scope.id;
    const affected =
      request.scope.kind === 'global'
        ? [...this.#inFlight]
        : [...this.#inFlight].filter((id) => id === scopeId);

    for (const id of affected) this.#control.recordQuarantine(id);
    this.#control.recordDeny(request);

    // The verifier holds no long-lived state to isolate: its workspaces are torn down in the
    // `finally` of each run. Naming the in-flight verifications is the honest answer — they
    // are what an operator would otherwise have to guess at.
    return this.#control.ack('contained', affected.map((id) => `verifier:verification:${id}`));
  }

  async revoke(request: RevokeRequest): Promise<ControlAck> {
    this.#control.bumpRevocationEpoch(request.revocation_epoch);
    // Nothing to revoke, and that is a property worth reporting rather than hiding: the
    // verifier is granted no capability it could hand on, which is the point of S12.
    return this.#control.ack('not_applicable', []);
  }

  // ------------------------------------------------------------------ internals

  async #runAll(
    manifest: VerifierManifest,
    target: VerificationTarget,
    evidenceRefs: readonly string[],
  ): Promise<CheckOutcome[]> {
    const workspace = await this.#provision(target);
    if (workspace.blocked !== null) return [workspace.blocked];

    try {
      const applicable = await this.#applicableChecks(manifest, target);
      const outcomes: CheckOutcome[] = [...applicable.skipped];

      for (const check of applicable.run) {
        outcomes.push(await this.#runOne(check, target));
      }

      outcomes.push(...(await this.#scan(manifest.forbidden, target)));
      outcomes.push(...(await this.#confirmEvidence(evidenceRefs, target)));
      return outcomes;
    } finally {
      if (workspace.id !== null) {
        await this.#deps.workspace.destroy(workspace.id, 'verification complete').catch(() => {
          // A workspace that outlives its verification is an operational problem, not a
          // reason to rewrite a verdict that has already been established from evidence.
        });
      }
    }
  }

  /**
   * A fresh, egress-denied workspace per attempt.
   *
   * `network_allowlist: []` means no egress at all rather than "unrestricted" — the
   * `CreateWorkspaceInput` contract is explicit about that, and a verifier that could reach
   * the network could be told what to conclude by whatever answered.
   */
  async #provision(target: VerificationTarget): Promise<{ id: string | null; blocked: CheckOutcome | null }> {
    const attempt = (this.#attempts.get(target.workflow_id) ?? 0) + 1;
    this.#attempts.set(target.workflow_id, attempt);

    try {
      const descriptor = await this.#deps.workspace.create({
        workflow_id: target.workflow_id,
        attempt,
        worker_image: this.#deps.config.workerImage,
        network_allowlist: [],
        limits: this.#deps.config.limits,
        mounts: [],
      });

      if (descriptor.state === 'quarantined' || descriptor.state === 'terminated') {
        return {
          id: descriptor.workspace_id,
          blocked: unavailable(
            'workspace',
            `workspace is ${descriptor.state}; no check could run against the target`,
            target,
          ),
        };
      }
      return { id: descriptor.workspace_id, blocked: null };
    } catch (error) {
      // No workspace means no check ran. That is `unavailable` for the whole run — never an
      // empty check list, which `aggregateVerdict` would also refuse but less legibly.
      return { id: null, blocked: unavailable('workspace', `could not provision: ${message(error)}`, target) };
    }
  }

  async #applicableChecks(
    manifest: VerifierManifest,
    target: VerificationTarget,
  ): Promise<{ run: ManifestCheck[]; skipped: CheckOutcome[] }> {
    const run = [...manifest.required];
    const skipped: CheckOutcome[] = [];
    const groups = Object.entries(manifest.conditional);
    if (groups.length === 0) return { run, skipped };

    if (this.#deps.conditions === undefined) {
      // Conditional groups exist but nothing can decide whether they apply. Running them all
      // would run checks that do not apply; dropping them silently would skip checks that do.
      // Neither is honest, so each becomes an explicit skip — which caps the verdict at
      // inconclusive rather than quietly producing a pass over an unexamined condition.
      for (const [condition, group] of groups) {
        for (const check of group) {
          skipped.push({
            name: check.name,
            status: 'skipped',
            exit_code: null,
            reason: `condition "${condition}" could not be evaluated: no condition evaluator is configured`,
            log_ref: null,
            observed_head_sha: target.head_sha,
            observed_diff_digest: target.diff_digest,
          });
        }
      }
      return { run, skipped };
    }

    let active: Set<string>;
    try {
      active = new Set(await this.#deps.conditions.conditionsFor(target));
    } catch (error) {
      for (const [condition, group] of groups) {
        for (const check of group) {
          skipped.push(
            unavailable(check.name, `condition "${condition}" evaluator failed: ${message(error)}`, target),
          );
        }
      }
      return { run, skipped };
    }

    for (const [condition, group] of groups) {
      // A condition that does not hold is genuinely not applicable — it is not a skip, and
      // recording it as one would cap every verdict on every repository that declares any
      // conditional group at all.
      if (active.has(condition)) run.push(...group);
    }
    return { run, skipped };
  }

  async #runOne(check: ManifestCheck, target: VerificationTarget): Promise<CheckOutcome> {
    let outcome: CheckOutcome;
    try {
      outcome = await this.#deps.runner.run(check, target);
    } catch (error) {
      // A broken runner is `unavailable`, never `fail` and never `pass`. Calling it `fail`
      // would blame the change for a defect in the verifier's own tooling.
      return unavailable(check.name, `runner error: ${message(error)}`, target);
    }

    // The immutability check. A runner that observed a different commit or diff verified
    // something other than what was asked about, and a green result from it is worse than no
    // result: it certifies a commit nobody named.
    if (outcome.observed_head_sha !== target.head_sha || outcome.observed_diff_digest !== target.diff_digest) {
      return {
        ...outcome,
        status: 'fail',
        exit_code: outcome.exit_code,
        reason:
          `target moved under the check: asked about ${short(target.head_sha)}/${short(target.diff_digest)}, ` +
          `ran against ${short(outcome.observed_head_sha)}/${short(outcome.observed_diff_digest)}`,
      };
    }

    // A skipped or unavailable check with no reason would be indistinguishable from an absent
    // one in the evidence bundle, whose schema requires the reason for exactly that purpose.
    if ((outcome.status === 'skipped' || outcome.status === 'unavailable') && outcome.reason === null) {
      return { ...outcome, reason: 'the runner reported no reason' };
    }
    return outcome;
  }

  async #scan(forbidden: readonly ForbiddenRule[], target: VerificationTarget): Promise<CheckOutcome[]> {
    const outcomes: CheckOutcome[] = [];
    const byKind = new Map<ScannerKind, Scanner>();
    for (const scanner of this.#deps.scanners) byKind.set(scanner.kind, scanner);

    for (const rule of forbidden) {
      const kind = RULE_SCANNER[rule];
      const scanner = byKind.get(kind);
      const name = `forbidden:${rule}`;

      if (scanner === undefined) {
        // The manifest forbids something no hook was wired up to detect. Reporting this as a
        // pass is the exact failure the "skipped is never a pass" criterion is about.
        outcomes.push(unavailable(name, `no ${kind} scanner is configured to enforce "${rule}"`, target));
        continue;
      }

      let result;
      try {
        result = await scanner.scan(target);
      } catch (error) {
        outcomes.push(unavailable(name, `${kind} scanner error: ${message(error)}`, target));
        continue;
      }

      if (result.status === 'unavailable') {
        outcomes.push(unavailable(name, result.reason ?? `${kind} scanner was unavailable`, target));
        continue;
      }

      const hits = result.findings.filter((finding) => finding.rule === rule);
      outcomes.push({
        name,
        status: hits.length === 0 ? 'pass' : 'fail',
        exit_code: hits.length === 0 ? 0 : 1,
        reason: hits.length === 0 ? null : hits.map((hit) => hit.detail).join('; ').slice(0, 300),
        log_ref: null,
        observed_head_sha: target.head_sha,
        observed_diff_digest: target.diff_digest,
      });
    }
    return outcomes;
  }

  /**
   * Confirm the evidence the request points at actually exists.
   *
   * A dangling evidence ref is how a bundle comes to look complete while resting on nothing.
   * The verifier reads evidence — it is one of the four things it is allowed to receive — so
   * checking that it is there is squarely its job.
   */
  async #confirmEvidence(refs: readonly string[], target: VerificationTarget): Promise<CheckOutcome[]> {
    if (refs.length === 0) return [];

    const missing: string[] = [];
    for (const ref of refs) {
      try {
        const artifact = await this.#deps.evidence.getArtifact(ref);
        if (artifact === null) missing.push(ref);
      } catch (error) {
        return [unavailable('evidence', `evidence store unreachable: ${message(error)}`, target)];
      }
    }

    return [
      {
        name: 'evidence',
        status: missing.length === 0 ? 'pass' : 'fail',
        exit_code: missing.length === 0 ? 0 : 1,
        reason: missing.length === 0 ? null : `evidence refs not found: ${missing.join(', ')}`,
        log_ref: null,
        observed_head_sha: target.head_sha,
        observed_diff_digest: target.diff_digest,
      },
    ];
  }

  #fail(code: ErrorCode, details?: Record<string, string | number | boolean | null>): never {
    throw new ContractError(
      makeError(code, {
        diagnostic_ref: `verifier:${this.#deps.ids.next('artifact')}`,
        occurred_at: this.#deps.clock.nowIso(),
        ...(details === undefined ? {} : { details }),
      }),
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function short(digest: string): string {
  return digest.length <= 16 ? digest : `${digest.slice(0, 16)}...`;
}
