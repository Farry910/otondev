import { evidenceGateFailures } from '@otondev/contracts';
import type {
  EvidenceArtifact,
  EvidenceBundle,
  ExecutionCommand,
} from '@otondev/contracts';
import { FakeServiceBase } from './base.js';
import type { FakeDefaults } from './base.js';
import type { RuntimeContext } from '../runtime.js';
import type {
  AssembleBundleInput,
  Checkpoint,
  CreateWorkspaceInput,
  EgressRecord,
  EvidenceClient,
  ExecutorClient,
  PutArtifactInput,
  StepResult,
  VerifierClient,
  VerifierVerdict,
  VerifyInput,
  WorkspaceClient,
  WorkspaceDescriptor,
} from '../services/execution-plane.js';
import { digestOf, envelopeFor, hexDigestOf, plusSeconds } from './support.js';

/** Minimal in-memory fakes, S9-S12. */

// -------------------------------------------------------------------------------- S9

export class FakeEvidence extends FakeServiceBase implements EvidenceClient {
  readonly serviceId = 'evidence' as const;
  readonly #artifacts = new Map<string, { artifact: EvidenceArtifact; content: Uint8Array }>();
  readonly #byDigest = new Map<string, string>();
  readonly #bundles = new Map<string, EvidenceBundle>();

  async putArtifact(input: PutArtifactInput): Promise<EvidenceArtifact> {
    const digest = digestOf(input.content);
    // Content-addressed: the same bytes twice yield the same ref and store once. Anything
    // else makes "digests are stable across re-assembly" (S9 exit criterion) untestable.
    const existingRef = this.#byDigest.get(digest);
    if (existingRef !== undefined) {
      const existing = this.#artifacts.get(existingRef);
      if (existing !== undefined) return existing.artifact;
    }

    const ref = this.id('artifact');
    const artifact: EvidenceArtifact = {
      ref,
      kind: input.kind,
      digest,
      retention: input.retention,
    };
    this.#artifacts.set(ref, { artifact, content: input.content });
    this.#byDigest.set(digest, ref);
    return artifact;
  }

  async getArtifact(ref: string): Promise<{ artifact: EvidenceArtifact; content: Uint8Array } | null> {
    return this.#artifacts.get(ref) ?? null;
  }

  async assembleBundle(input: AssembleBundleInput): Promise<EvidenceBundle> {
    const failures = evidenceGateFailures(input);
    // Refuses an incomplete bundle rather than storing one (S9 exit criterion). The failing
    // reasons go in `details`; the public message stays a registry string.
    if (failures.length > 0) this.fail('EVIDENCE_INCOMPLETE', { failures: failures.join('; ') });
    return this.#store(input, null);
  }

  async getBundle(bundleId: string): Promise<EvidenceBundle | null> {
    return this.#bundles.get(bundleId) ?? null;
  }

  async supersede(bundleId: string, input: AssembleBundleInput): Promise<EvidenceBundle> {
    const original = this.#bundles.get(bundleId);
    if (original === undefined) this.fail('EVIDENCE_IMMUTABLE', { reason: 'no such bundle' });
    const replacement = this.#store(input, bundleId);
    // The original stays retrievable and byte-identical. "We corrected the evidence" and
    // "we replaced the evidence" must remain distinguishable afterwards (contracts §10).
    this.#bundles.set(bundleId, original);
    return replacement;
  }

  #store(input: AssembleBundleInput, supersedes: string | null): EvidenceBundle {
    const id = this.id('evidence');
    const bundle: EvidenceBundle = {
      ...envelopeFor(this.runtime, 'agentdev.evidence.v2', id, this.defaults.tenantId, 'evidence', {
        dataClasses: ['internal_source'],
      }),
      workflow_id: input.workflow_id,
      task_source: input.task_source,
      repository: input.repository,
      environment: input.environment,
      checks: input.checks,
      verifier: input.verifier,
      policy_refs: input.policy_refs,
      approval_refs: input.approval_refs,
      action_refs: input.action_refs,
      artifacts: input.artifacts,
      supersedes,
      signature: { alg: 'ed25519', key_id: 'fake-evidence-key', value: 'ZmFrZQ' },
    };
    this.#bundles.set(id, bundle);
    return bundle;
  }
}

// ------------------------------------------------------------------------------- S10

export class FakeWorkspace extends FakeServiceBase implements WorkspaceClient {
  readonly serviceId = 'workspace' as const;
  readonly #workspaces = new Map<string, WorkspaceDescriptor>();
  readonly #egress = new Map<string, EgressRecord[]>();
  readonly #allowlists = new Map<string, readonly string[]>();

  async create(input: CreateWorkspaceInput): Promise<WorkspaceDescriptor> {
    this.assertNotDenied(input.workflow_id);
    const key = `${input.workflow_id}:${input.attempt}`;
    // Fresh per (workflow, attempt). Reusing one is how state leaks between attempts and a
    // retry inherits the failure it was meant to escape.
    for (const existing of this.#workspaces.values()) {
      if (`${existing.workflow_id}:${existing.attempt}` === key && existing.state !== 'terminated') {
        this.fail('WORKSPACE_QUOTA_EXCEEDED', { reason: 'workspace already exists for this attempt' });
      }
    }

    const workspaceId = this.id('workspace');
    const descriptor: WorkspaceDescriptor = {
      workspace_id: workspaceId,
      workflow_id: input.workflow_id,
      attempt: input.attempt,
      state: 'ready',
      worker_image: input.worker_image,
      created_at: this.runtime.clock.nowIso(),
      termination_reason: null,
    };
    this.#workspaces.set(workspaceId, descriptor);
    this.#allowlists.set(workspaceId, input.network_allowlist);
    this.#egress.set(workspaceId, []);
    return descriptor;
  }

  async get(workspaceId: string): Promise<WorkspaceDescriptor | null> {
    return this.#workspaces.get(workspaceId) ?? null;
  }

  async destroy(workspaceId: string, reason: string): Promise<void> {
    const workspace = this.#workspaces.get(workspaceId);
    // Completes after a worker crash (S10 exit criterion) — so an unknown or already-gone
    // workspace is a successful teardown, not an error to retry forever.
    if (workspace === undefined) return;
    this.#workspaces.set(workspaceId, { ...workspace, state: 'terminated', termination_reason: reason });
  }

  async quarantineWorkspace(workspaceId: string, reason: string): Promise<WorkspaceDescriptor> {
    const workspace = this.#workspaces.get(workspaceId);
    if (workspace === undefined) this.fail('INTERNAL', { reason: 'unknown workspace' });
    const quarantined: WorkspaceDescriptor = {
      ...workspace,
      state: 'quarantined',
      termination_reason: reason,
    };
    this.#workspaces.set(workspaceId, quarantined);
    return quarantined;
  }

  async egressLog(workspaceId: string): Promise<EgressRecord[]> {
    return this.#egress.get(workspaceId) ?? [];
  }

  /**
   * Test seam: attempt an outbound connection. Deny-by-default — an empty allow-list means
   * no egress at all, which is the difference between "restricted" and "unconfigured".
   */
  attemptEgress(workspaceId: string, destination: string): boolean {
    const allowed = (this.#allowlists.get(workspaceId) ?? []).includes(destination);
    const log = this.#egress.get(workspaceId) ?? [];
    log.push({ workspace_id: workspaceId, destination, allowed, at: this.runtime.clock.nowIso() });
    this.#egress.set(workspaceId, log);
    return allowed;
  }

  /** The emergency-stop verb: isolate every workspace in scope and say which ones. */
  override async quarantine(request: Parameters<FakeServiceBase['quarantine']>[0]) {
    const contained: string[] = [];
    for (const workspace of this.#workspaces.values()) {
      if (request.scope.kind === 'workspace' && workspace.workspace_id !== request.scope.id) continue;
      if (request.scope.kind === 'workflow' && workspace.workflow_id !== request.scope.id) continue;
      if (workspace.state === 'terminated') continue;
      this.#workspaces.set(workspace.workspace_id, {
        ...workspace,
        state: 'quarantined',
        termination_reason: request.reason,
      });
      contained.push(workspace.workspace_id);
    }
    return this.control.ack('contained', contained);
  }
}

// ------------------------------------------------------------------------------- S11

export class FakeExecutor extends FakeServiceBase implements ExecutorClient {
  readonly serviceId = 'executor' as const;
  readonly #checkpoints = new Map<string, Checkpoint[]>();
  readonly #cancelled = new Set<string>();
  /** Base SHAs the repository has moved to since the command was built. */
  readonly movedBaseShas = new Map<string, string>();
  readonly #workspace: WorkspaceClient;

  constructor(runtime: RuntimeContext, defaults: FakeDefaults, deps: { workspace: WorkspaceClient }) {
    super(runtime, defaults);
    this.#workspace = deps.workspace;
  }

  async execute(command: ExecutionCommand): Promise<StepResult> {
    this.assertNotDenied(command.workflow_id);

    if (this.#cancelled.has(command.cancellation_token)) {
      return this.#result(command, 'cancelled');
    }

    const workspace = await this.#workspace.get(command.workspace_id);
    if (workspace === null || workspace.state === 'quarantined') this.fail('WORKSPACE_QUARANTINED');
    if (workspace.state === 'terminated') this.fail('WORKSPACE_QUOTA_EXCEEDED');

    if (Date.parse(command.timeout_at) <= this.runtime.clock.nowMs()) this.fail('TIMEOUT');

    // A base that moved mid-execution returns to planning rather than improvising on top of
    // someone else's commit (S11 exit criterion).
    const moved = this.movedBaseShas.get(command.workflow_id);
    if (moved !== undefined && moved !== command.base_sha) {
      return this.#result(command, 'base_sha_changed');
    }

    const checkpoint: Checkpoint = {
      checkpoint_ref: this.id('checkpoint'),
      workflow_id: command.workflow_id,
      step_id: command.step_id,
      milestone: `${command.step_id}:complete`,
      created_at: this.runtime.clock.nowIso(),
    };
    const list = this.#checkpoints.get(command.workflow_id) ?? [];
    list.push(checkpoint);
    this.#checkpoints.set(command.workflow_id, list);

    return { ...this.#result(command, 'succeeded'), checkpoint_ref: checkpoint.checkpoint_ref };
  }

  async cancel(cancellationToken: string): Promise<void> {
    this.#cancelled.add(cancellationToken);
  }

  async checkpoints(workflowId: string): Promise<Checkpoint[]> {
    return this.#checkpoints.get(workflowId) ?? [];
  }

  #result(command: ExecutionCommand, status: StepResult['status']): StepResult {
    return {
      workflow_id: command.workflow_id,
      step_id: command.step_id,
      status,
      output: { schema: command.response_schema, ok: status === 'succeeded' },
      log_ref: null,
      checkpoint_ref: null,
      finished_at: this.runtime.clock.nowIso(),
    };
  }
}

// ------------------------------------------------------------------------------- S12

export class FakeVerifier extends FakeServiceBase implements VerifierClient {
  readonly serviceId = 'verifier' as const;
  readonly supportedManifestVersions = new Set(['verifier-v3']);
  /** Checks the fake reports. A test sets these to drive a verdict. */
  checks: VerifierVerdict['checks'] = [{ name: 'unit', status: 'pass', reason: null }];

  async verify(input: VerifyInput): Promise<VerifierVerdict> {
    // Fails closed on a manifest version it does not implement (S12 exit criterion).
    if (!this.supportedManifestVersions.has(input.manifest_version)) {
      this.fail('VERIFY_MANIFEST_INVALID', { version: input.manifest_version });
    }

    const failed = this.checks.some((check) => check.status === 'fail');
    const incomplete = this.checks.some(
      (check) => check.status === 'skipped' || check.status === 'unavailable',
    );

    return {
      workflow_id: input.workflow_id,
      // A skipped check is never a pass. It downgrades the verdict to inconclusive, and the
      // delivery gate refuses an inconclusive bundle.
      verdict: failed ? 'fail' : incomplete ? 'inconclusive' : 'pass',
      checks: this.checks,
      limitations: this.checks
        .filter((check) => check.status === 'skipped' || check.status === 'unavailable')
        .map((check) => `${check.name}: ${check.reason ?? 'no reason recorded'}`),
      verifier_version: 'verifier-v3',
      completed_at: this.runtime.clock.nowIso(),
    };
  }

  async validateManifest(manifest: unknown): Promise<{ valid: boolean; version: string | null; errors: string[] }> {
    if (typeof manifest !== 'object' || manifest === null) {
      return { valid: false, version: null, errors: ['manifest is not an object'] };
    }
    const version = (manifest as Record<string, unknown>)['version'];
    if (typeof version !== 'string') {
      return { valid: false, version: null, errors: ['manifest has no version'] };
    }
    if (!this.supportedManifestVersions.has(version)) {
      return { valid: false, version, errors: [`unsupported manifest version ${version}`] };
    }
    return { valid: true, version, errors: [] };
  }
}

/** Convenience for tests that need a plausible artifact digest without real bytes. */
export function fakeContent(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export { hexDigestOf, plusSeconds };
