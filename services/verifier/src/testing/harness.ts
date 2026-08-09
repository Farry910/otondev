/**
 * Test doubles for the verifier's ports.
 *
 * Lives under `src/testing/` because the boundary rules exempt that directory from
 * `no-testkit-in-production-code` and `not-to-dev-dep` — a deliberate carve-out, not a
 * loophole: these are scriptable stand-ins for a process runner and three scanners, and
 * building them per test file would produce four slightly different notions of what a
 * "runner that failed" looks like.
 *
 * Everything here is scriptable rather than clever. A test says what the runner returns; the
 * assertions are about what the *verifier* does with it.
 */

import { createFakeRegistry } from '@otondev/sdk';
import type { ServiceRegistry } from '@otondev/sdk';
import { FakeClock, deterministicIdFactory } from '@otondev/testkit';
import type { Clock, IdFactory, ResourceLimits } from '@otondev/contracts';
import type { CheckOutcome, CheckRunner, ScanResult, Scanner, ScannerKind, VerificationTarget } from '../ports.js';
import type { ConditionEvaluator, ManifestSource, VerifierConfig, VerifierDeps } from '../verifier.js';
import type { ManifestCheck } from '../manifest.js';

export const HEAD_SHA = 'a'.repeat(40);
export const OTHER_SHA = 'b'.repeat(40);
export const DIFF_DIGEST = `sha256:${'c'.repeat(64)}`;
export const OTHER_DIFF = `sha256:${'d'.repeat(64)}`;
export const GOAL_DIGEST = `sha256:${'e'.repeat(64)}`;
export const WORKER_IMAGE = `ghcr.io/otondev/verifier@sha256:${'f'.repeat(64)}`;

export const LIMITS: ResourceLimits = {
  cpu_seconds: 600,
  memory_mb: 2048,
  disk_mb: 8192,
  wall_seconds: 1800,
  usd_max: 1,
};

/** A manifest document as `task-engine.md` writes it, valid for `verifier-v3`. */
export function validManifestDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    required: [
      { name: 'unit', command: 'make test-unit', timeout: 900 },
      { name: 'lint', command: 'make lint', timeout: 300 },
    ],
    evidence: { retain_logs_days: 14, screenshots: 'on_ui_change' },
    forbidden: ['generated-secrets'],
    ...overrides,
  };
}

export class StubManifestSource implements ManifestSource {
  #document: unknown;

  constructor(document: unknown = validManifestDocument()) {
    this.#document = document;
  }

  set(document: unknown): void {
    this.#document = document;
  }

  async load(_versionRef: string): Promise<unknown> {
    return this.#document;
  }
}

export interface ScriptedOutcome {
  status: CheckOutcome['status'];
  exit_code?: number | null;
  reason?: string | null;
  observed_head_sha?: string;
  observed_diff_digest?: string;
}

/**
 * A check runner whose every answer is scripted by name.
 *
 * Defaults to `pass` for an unscripted check so a test states only what it is about. The
 * default is safe here precisely because it is the *test's* default, not the verifier's —
 * the verifier never invents a pass, and several cases below prove it.
 */
export class ScriptedRunner implements CheckRunner {
  readonly calls: string[] = [];
  readonly #script = new Map<string, ScriptedOutcome>();
  #throwFor: string | null = null;

  script(name: string, outcome: ScriptedOutcome): this {
    this.#script.set(name, outcome);
    return this;
  }

  throwOn(name: string): this {
    this.#throwFor = name;
    return this;
  }

  async run(check: ManifestCheck, target: VerificationTarget): Promise<CheckOutcome> {
    this.calls.push(check.name);
    if (this.#throwFor === check.name) throw new Error(`runner exploded on ${check.name}`);

    const scripted = this.#script.get(check.name);
    return {
      name: check.name,
      status: scripted?.status ?? 'pass',
      exit_code: scripted?.exit_code ?? (scripted?.status === undefined || scripted.status === 'pass' ? 0 : 1),
      reason: scripted?.reason ?? null,
      log_ref: null,
      observed_head_sha: scripted?.observed_head_sha ?? target.head_sha,
      observed_diff_digest: scripted?.observed_diff_digest ?? target.diff_digest,
    };
  }
}

export class ScriptedScanner implements Scanner {
  readonly kind: ScannerKind;
  #result: ScanResult;
  #throws = false;

  constructor(kind: ScannerKind, result?: Partial<ScanResult>) {
    this.kind = kind;
    this.#result = { kind, status: 'clean', findings: [], reason: null, ...result };
  }

  set(result: Partial<ScanResult>): this {
    this.#result = { ...this.#result, ...result };
    return this;
  }

  throws(): this {
    this.#throws = true;
    return this;
  }

  async scan(_target: VerificationTarget): Promise<ScanResult> {
    if (this.#throws) throw new Error(`${this.kind} scanner exploded`);
    return this.#result;
  }
}

export class StubConditions implements ConditionEvaluator {
  #active: readonly string[];
  #throws = false;

  constructor(active: readonly string[] = []) {
    this.#active = active;
  }

  throws(): this {
    this.#throws = true;
    return this;
  }

  async conditionsFor(_target: VerificationTarget): Promise<readonly string[]> {
    if (this.#throws) throw new Error('cannot read the diff');
    return this.#active;
  }
}

export interface Harness {
  deps: VerifierDeps;
  clock: FakeClock;
  ids: IdFactory;
  services: ServiceRegistry;
  manifests: StubManifestSource;
  runner: ScriptedRunner;
  scanners: ScriptedScanner[];
}

export interface HarnessOptions {
  manifest?: unknown;
  runner?: ScriptedRunner;
  scanners?: ScriptedScanner[];
  conditions?: ConditionEvaluator;
  config?: Partial<VerifierConfig>;
  clock?: Clock;
  ids?: IdFactory;
}

/** Everything a `VerifierService` needs, with the two real peers (workspace, evidence) faked. */
export function harness(options: HarnessOptions = {}): Harness {
  const clock = (options.clock as FakeClock | undefined) ?? new FakeClock('2026-07-30T08:00:00Z');
  const ids = options.ids ?? deterministicIdFactory({ clock });
  const { services } = createFakeRegistry({ clock, ids });

  const manifests =
    options.manifest === undefined ? new StubManifestSource() : new StubManifestSource(options.manifest);
  const runner = options.runner ?? new ScriptedRunner();
  const scanners = options.scanners ?? [new ScriptedScanner('secret'), new ScriptedScanner('diff'), new ScriptedScanner('licence')];

  const deps: VerifierDeps = {
    workspace: services.workspace,
    evidence: services.evidence,
    clock,
    ids,
    manifests,
    runner,
    scanners,
    config: {
      verifierVersion: 'verifier-v3',
      workerImage: WORKER_IMAGE,
      limits: LIMITS,
      ...options.config,
    },
    // Assigned conditionally: `exactOptionalPropertyTypes` makes `conditions: undefined`
    // different from an absent key, and the service branches on absence.
    ...(options.conditions === undefined ? {} : { conditions: options.conditions }),
  };

  return { deps, clock, ids, services, manifests, runner, scanners };
}

/**
 * Wrap a peer fake, replacing some methods and delegating the rest.
 *
 * `{...fake, create: ...}` looks like it does this and does not: the fakes are classes, and
 * object spread copies own enumerable properties only, so every prototype method silently
 * becomes `undefined`. That produced a test which passed for entirely the wrong reason — the
 * verifier reported `unavailable` because `workspace.create` was missing, not because of
 * anything the test was about.
 */
export function withOverrides<T extends object>(inner: T, overrides: Partial<T>): T {
  return new Proxy(inner, {
    get(target, property) {
      if (property in overrides) {
        return (overrides as Record<string | symbol, unknown>)[property as string];
      }
      // Bound to `target`, not to the proxy: the fakes use `#private` fields, and calling a
      // method with the proxy as `this` would throw on the first private-field read.
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  });
}

/** A well-formed `VerifyInput`. Tests override only the field they are about. */
export function verifyInput(overrides: Record<string, unknown> = {}): {
  workflow_id: string;
  goal_digest: string;
  diff_digest: string;
  head_sha: string;
  definition_of_done_ref: string;
  manifest_version: string;
  evidence_refs: readonly string[];
} {
  return {
    workflow_id: 'wf_01JQ0000000000000000000000',
    goal_digest: GOAL_DIGEST,
    diff_digest: DIFF_DIGEST,
    head_sha: HEAD_SHA,
    definition_of_done_ref: 'dod_default_v1',
    manifest_version: 'verifier-v3',
    evidence_refs: [],
    ...overrides,
  };
}
