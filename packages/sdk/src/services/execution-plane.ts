import type {
  CheckStatus,
  EvidenceArtifact,
  EvidenceBundle,
  EvidenceCheck,
  ExecutionCommand,
  ResourceLimits,
} from '@otondev/contracts';
import type { ServiceClient } from '../hooks.js';

/**
 * Execution-plane client interfaces, S9-S12.
 *
 * Three of the four run as their own process (implementation-plan §2): the workspace
 * manager, the task executor and the verifier. That is a trust boundary, not a deployment
 * preference, and it shows up in these interfaces as capabilities that are deliberately
 * absent — see the note on {@link VerifierClient}.
 */

// --------------------------------------------------------------------------- S9 Evidence

export interface PutArtifactInput {
  kind: EvidenceArtifact['kind'];
  content: Uint8Array;
  retention: EvidenceArtifact['retention'];
  /** Data classes travel with the artifact so retention and export can honour them. */
  data_classes: EvidenceBundle['data_classes'];
}

export interface AssembleBundleInput {
  workflow_id: string;
  task_source: string;
  repository: EvidenceBundle['repository'];
  environment: EvidenceBundle['environment'];
  checks: EvidenceCheck[];
  verifier: EvidenceBundle['verifier'];
  policy_refs: string[];
  approval_refs: string[];
  action_refs: string[];
  artifacts: EvidenceArtifact[];
}

export interface EvidenceClient extends ServiceClient {
  /** Content-addressed: the same bytes twice yield the same ref and store once. */
  putArtifact(input: PutArtifactInput): Promise<EvidenceArtifact>;
  getArtifact(ref: string): Promise<{ artifact: EvidenceArtifact; content: Uint8Array } | null>;
  /**
   * Rejects an incomplete bundle rather than storing one (S9 exit criterion). Digests are
   * stable across re-assembly of identical inputs, which is what makes a bundle comparable
   * to the one in the audit log.
   */
  assembleBundle(input: AssembleBundleInput): Promise<EvidenceBundle>;
  getBundle(bundleId: string): Promise<EvidenceBundle | null>;
  /**
   * Corrections supersede; they never mutate (contracts §10). The original stays retrievable
   * and intact, because "we fixed the evidence" and "we replaced the evidence" have to be
   * distinguishable afterwards.
   */
  supersede(bundleId: string, input: AssembleBundleInput): Promise<EvidenceBundle>;
}

// -------------------------------------------------------------------------- S10 Workspace

export interface CreateWorkspaceInput {
  workflow_id: string;
  attempt: number;
  /** Pinned by digest. A tag is a promise; a digest is a fact. */
  worker_image: string;
  /** Deny by default: an empty list means no egress at all, not "unrestricted". */
  network_allowlist: readonly string[];
  limits: ResourceLimits;
  mounts: readonly { source: string; target: string; readonly: boolean }[];
}

export interface WorkspaceDescriptor {
  workspace_id: string;
  workflow_id: string;
  attempt: number;
  state: 'provisioning' | 'ready' | 'terminated' | 'quarantined';
  worker_image: string;
  created_at: string;
  /** Populated on teardown. Quotas terminate rather than degrade (S10 exit criterion). */
  termination_reason: string | null;
}

export interface EgressRecord {
  workspace_id: string;
  destination: string;
  allowed: boolean;
  at: string;
}

export interface WorkspaceClient extends ServiceClient {
  /** Fresh per `(workflow, attempt)`. Reuse is what leaks state between attempts. */
  create(input: CreateWorkspaceInput): Promise<WorkspaceDescriptor>;
  get(workspaceId: string): Promise<WorkspaceDescriptor | null>;
  /** Completes even after the worker crashed (S10 exit criterion). */
  destroy(workspaceId: string, reason: string): Promise<void>;
  /**
   * Named `quarantineWorkspace`, not `quarantine`, because `ControlHooks.quarantine` is the
   * emergency-stop verb every service shares and it takes a scope, not an id. Two methods
   * with one name and different meanings is the kind of ambiguity an operator resolves
   * wrongly at 3am.
   */
  quarantineWorkspace(workspaceId: string, reason: string): Promise<WorkspaceDescriptor>;
  /** Every attempted egress, allowed or not. The denied ones are the interesting ones. */
  egressLog(workspaceId: string): Promise<EgressRecord[]>;
}

// --------------------------------------------------------------------------- S11 Executor

export interface StepResult {
  workflow_id: string;
  step_id: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'budget_exhausted' | 'base_sha_changed';
  /** Structured, schema-validated. The narrative is not the result. */
  output: unknown;
  /** Bounded and treated as untrusted (S11 exit criterion). */
  log_ref: string | null;
  checkpoint_ref: string | null;
  finished_at: string;
}

export interface Checkpoint {
  checkpoint_ref: string;
  workflow_id: string;
  step_id: string;
  /** A deterministic milestone, not a periodic snapshot: resuming must be repeatable. */
  milestone: string;
  created_at: string;
}

export interface ExecutorClient extends ServiceClient {
  /**
   * Rejects a command with a stale fencing token, an expired capability, a changed plan
   * digest or a missing policy decision — before doing any work (contracts §4).
   */
  execute(command: ExecutionCommand): Promise<StepResult>;
  cancel(cancellationToken: string): Promise<void>;
  checkpoints(workflowId: string): Promise<Checkpoint[]>;
}

// --------------------------------------------------------------------------- S12 Verifier

export interface VerifyInput {
  workflow_id: string;
  /** The goal, not the executor's account of the goal. */
  goal_digest: string;
  /** The immutable diff and commit. */
  diff_digest: string;
  head_sha: string;
  definition_of_done_ref: string;
  manifest_version: string;
  evidence_refs: readonly string[];
}

export interface VerifierVerdict {
  workflow_id: string;
  verdict: 'pass' | 'fail' | 'inconclusive';
  checks: { name: string; status: CheckStatus; reason: string | null }[];
  /** What the verifier could not establish. An empty array is a claim, so it must be earned. */
  limitations: string[];
  verifier_version: string;
  completed_at: string;
}

/**
 * The verifier "receives goal, diff, definition of done, and evidence — never the executor's
 * narrative — and holds no publish capability" (implementation-plan §5 S12).
 *
 * Both halves are enforced by shape. {@link VerifyInput} has no field the executor's prose
 * could occupy, and this interface has no publish, comment, approve or transition method —
 * so the exit criterion "the verifier cannot publish or approve" is true of the type, not
 * just of the current implementation.
 */
export interface VerifierClient extends ServiceClient {
  verify(input: VerifyInput): Promise<VerifierVerdict>;
  /** Fails closed on a manifest version it does not implement (S12 exit criterion). */
  validateManifest(manifest: unknown): Promise<{ valid: boolean; version: string | null; errors: string[] }>;
}
