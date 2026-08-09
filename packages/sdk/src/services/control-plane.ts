import type {
  ActionClass,
  Approval,
  AuditRecord,
  AuditSeverity,
  AutonomyLevel,
  Capability,
  CapabilityRequest,
  CapabilityVerdict,
  CognitionRequest,
  CognitionResult,
  DataClass,
  DecisionRequest,
  Environment,
  ErrorCode,
  ExternalAction,
  IngressEvent,
  Plan,
  PolicyDecision,
  ReconcileResult,
  RiskLevel,
  TransitionChannel,
  WorkflowLease,
  WorkflowRecord,
  WorkflowState,
} from '@otondev/contracts';
import type { ServiceClient } from '../hooks.js';

/**
 * Control-plane client interfaces, S1-S8.
 *
 * Read these as the *only* thing a peer session knows about the service. That is the whole
 * mechanism: implementation-plan §1 property 3 says a package "consumes every peer through
 * an interface, never a concrete import", and the `no-cross-service` boundary rule makes it
 * a build failure to do otherwise.
 *
 * Failures are thrown as `ContractError` carrying an `agentdev.error.v2` contract, never as
 * a bare `Error` and never as a `null` that means several different things. A method that
 * legitimately has an "absent" answer says so in its return type.
 */

// ---------------------------------------------------------------------------- S1 Ingress

export interface WebhookDelivery {
  system: IngressEvent['source']['system'];
  installation_id: string;
  /** Raw body bytes. Signature verification happens over these, not over parsed JSON. */
  body: Uint8Array;
  headers: Readonly<Record<string, string>>;
  received_at: string;
}

export type IngestOutcome =
  | { status: 'accepted'; event_id: string }
  /**
   * Contracts §2: "Duplicate events return the existing canonical event ID." A duplicate is
   * a normal outcome with a useful answer, not an error — modelling it as one is how callers
   * end up retrying and creating the duplicate they were avoiding.
   */
  | { status: 'duplicate'; event_id: string }
  | { status: 'rejected'; code: ErrorCode };

export interface IngressClient extends ServiceClient {
  /**
   * Acknowledges only after authentication, dedupe persistence and durable enqueue all
   * succeed (contracts §2). A resolved promise therefore means the event is durable.
   */
  ingest(delivery: WebhookDelivery): Promise<IngestOutcome>;
  getEvent(eventId: string): Promise<IngressEvent | null>;
  lookupByDedupeKey(dedupeKey: string): Promise<string | null>;
}

// --------------------------------------------------------------------------- S2 Workflow

export interface CreateWorkflowInput {
  tenant_id: string;
  agent_id: string;
  type: WorkflowRecord['type'];
  goal_ref: string;
  source_refs: string[];
  definition_of_done_ref: string;
  risk: RiskLevel;
  data_classes: DataClass[];
  autonomy_required: AutonomyLevel;
  priority: number;
  budget: WorkflowRecord['budget'];
}

export interface TransitionInput {
  workflow_id: string;
  /** Compare-and-set (contracts §3). A mismatch is `STATE_VERSION_CONFLICT`, not a retry. */
  expected_state_version: number;
  to: WorkflowState;
  channel: TransitionChannel;
  reason_codes: string[];
  /** Required on the `normal` channel; a stale token is `LEASE_FENCED`. */
  fencing_token?: number;
}

export interface AcquireLeaseInput {
  workflow_id: string;
  owner: string;
  ttl_seconds: number;
}

export interface WorkflowEngineClient extends ServiceClient {
  create(input: CreateWorkflowInput): Promise<WorkflowRecord>;
  get(workflowId: string): Promise<WorkflowRecord | null>;
  transition(input: TransitionInput): Promise<WorkflowRecord>;
  /** Exactly one of two simultaneous claimants wins (S2 exit criterion). */
  acquireLease(input: AcquireLeaseInput): Promise<WorkflowLease>;
  renewLease(workflowId: string, fencingToken: number, ttlSeconds: number): Promise<WorkflowLease>;
  releaseLease(workflowId: string, fencingToken: number): Promise<void>;
  scheduleWakeup(workflowId: string, at: string): Promise<void>;
  /** Workflows whose lease expired or whose wakeup is due. Drives RECOVERING. */
  recoveryScan(): Promise<string[]>;
}

// ------------------------------------------------------------------------- S3 Agent Core

export interface AgentStatus {
  workflow_id: string;
  /** Derived from workflow truth, never from the Core's own belief (S3 brief). */
  state: WorkflowState;
  summary: string;
  blocked_on: string | null;
  updated_at: string;
}

export interface ResourceClaim {
  resource: string;
  workflow_id: string;
  priority: number;
}

export interface AgentCoreClient extends ServiceClient {
  triage(eventId: string): Promise<{ workflow_id: string; accepted: boolean; reason_codes: string[] }>;
  buildPlan(workflowId: string): Promise<Plan>;
  requestDecision(workflowId: string, action: ActionClass): Promise<DecisionRequest>;
  status(workflowId: string): Promise<AgentStatus>;
  /**
   * The named-resource concurrency table from agent-core.md. Returns false rather than
   * queueing: an arbitration decision the caller cannot see is an arbitration decision
   * nobody can debug during an incident.
   */
  acquireResource(claim: ResourceClaim): Promise<boolean>;
  releaseResource(resource: string, workflowId: string): Promise<void>;
}

// ----------------------------------------------------------------------------- S4 Policy

export interface PolicyQuery {
  tenant_id: string;
  agent_id: string;
  workload_id: string;
  workflow_id: string;
  plan_id: string;
  action: ActionClass;
  resource: string;
  environment: Environment;
  parameter_digest: string;
  data_classes: DataClass[];
  /** Raises the floor; never lowers it. */
  incident_mode?: boolean;
}

export interface ApprovalBinding {
  action: ActionClass;
  resource: string;
  environment: Environment;
  parameter_digest: string;
  plan_digest: string;
}

export interface PolicyClient extends ServiceClient {
  /** An input the bundle does not recognise denies (S4 exit criterion). */
  evaluate(query: PolicyQuery): Promise<PolicyDecision>;
  /** `<name>@sha256:<digest>` — every decision is reproducible against it. */
  bundleRef(): Promise<string>;
  /**
   * The only way an approval comes into existence. Chat text, an emoji, a ticket label and
   * model output all fail here because none of them can produce an authenticated approver
   * and a complete binding (contracts §5).
   */
  createApproval(input: {
    decision_request_id: string;
    approver: Approval['approver'];
    binding: ApprovalBinding;
    expires_at: string;
    max_uses: number;
  }): Promise<Approval>;
  /** Rejects an expired, consumed, revoked or differently-bound approval. */
  consumeApproval(approvalId: string, binding: ApprovalBinding): Promise<Approval>;
  getApproval(approvalId: string): Promise<Approval | null>;
}

// ------------------------------------------------------------------- S5 Capability broker

export interface CapabilityCall {
  resource: string;
  parameter_digest: string;
  fencing_token: number;
}

/**
 * Note what is absent: there is no method that returns a secret value.
 *
 * The broker "retrieves secrets **only** for a trusted adapter and never returns a secret
 * value to a caller" (implementation-plan §5 S5). Expressing that as a missing method rather
 * than a documented rule means a caller cannot request one even by mistake, and the S5 exit
 * criterion "a secret value never appears in any contract, log, metric, artifact, or audit
 * payload" has one fewer way to be violated.
 */
export interface CapabilityBrokerClient extends ServiceClient {
  mint(request: CapabilityRequest): Promise<Capability>;
  /** Runs the full seven-check matrix from contracts §6, in order. */
  verify(capability: Capability, call: CapabilityCall): Promise<CapabilityVerdict>;
  /** Verify and decrement the use count atomically. Splitting them is a replay window. */
  consume(capabilityId: string, call: CapabilityCall): Promise<CapabilityVerdict>;
  revokeCapability(capabilityId: string, reason: string): Promise<void>;
  currentRevocationEpoch(): Promise<number>;
}

// -------------------------------------------------------------------------- S6 Cognition

export interface RealtimeSession {
  session_id: string;
  close(): Promise<void>;
}

/**
 * The gateway "returns no authorization field of any kind" (S6 exit criterion). None of the
 * methods below can express one, and `CognitionResult` has nowhere to put one.
 */
export interface CognitionClient extends ServiceClient {
  generateStructured(request: CognitionRequest): Promise<CognitionResult>;
  streamText(request: CognitionRequest): AsyncIterable<string>;
  realtimeSession(request: CognitionRequest): Promise<RealtimeSession>;
  embed(texts: readonly string[], dataClasses: readonly DataClass[]): Promise<number[][]>;
  cancel(requestId: string): Promise<void>;
}

// ------------------------------------------------------------------------- S7 Connectors

export interface PrepareActionInput {
  workflow_id: string;
  adapter: ExternalAction['adapter'];
  operation: string;
  action_class: ActionClass;
  resource: string;
  parameters: Readonly<Record<string, unknown>>;
  policy_decision_id: string;
  approval_id?: string;
}

export interface ConnectorBrokerClient extends ServiceClient {
  /** Assigns the idempotency key. Called once per intent, not once per attempt. */
  prepare(input: PrepareActionInput): Promise<ExternalAction>;
  /**
   * Verifies the capability against the parameters, then calls the provider. An ambiguous
   * timeout leaves the action in `outcome_unknown` and this rejects with
   * `ACTION_OUTCOME_UNKNOWN` — it does not retry, and neither may the caller until
   * {@link reconcile} says `absent` (contracts §7).
   */
  execute(actionId: string, capability: Capability): Promise<ExternalAction>;
  reconcile(actionId: string): Promise<ReconcileResult>;
  compensate(actionId: string): Promise<ExternalAction>;
  getAction(actionId: string): Promise<ExternalAction | null>;
}

// ------------------------------------------------------------------------------ S8 Audit

export interface AppendAuditInput {
  partition: string;
  severity: AuditSeverity;
  component: AuditRecord['component'];
  event: string;
  subject_refs: string[];
  attributes: Record<string, string | number | boolean | null>;
  message: string;
}

export interface ChainVerification {
  partition: string;
  intact: boolean;
  /** The first sequence number where the chain breaks. Null when intact. */
  broken_at: number | null;
  records_checked: number;
}

export interface AuditClient extends ServiceClient {
  /** Attributes are redacted on the way in; a secret-class key cannot be persisted. */
  append(input: AppendAuditInput): Promise<AuditRecord>;
  query(filter: { partition: string; since?: string; severity?: AuditSeverity }): Promise<AuditRecord[]>;
  /** Detects tampering: a removed or altered record breaks every digest after it. */
  verifyChain(partition: string): Promise<ChainVerification>;
  exportWorm(partition: string): Promise<{ ref: string; digest: string; records: number }>;
}
