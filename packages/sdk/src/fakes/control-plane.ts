import {
  canTransition,
  CAPABILITY_CHECKS,
  dedupeKey,
  isTerminal,
  mayAutoRetry,
} from '@otondev/contracts';
import type {
  ActionClass,
  Approval,
  AuditRecord,
  AuditSeverity,
  Capability,
  CapabilityCheck,
  CapabilityRequest,
  CapabilityVerdict,
  CognitionRequest,
  CognitionResult,
  DataClass,
  DecisionRequest,
  ExternalAction,
  IngressEvent,
  Plan,
  PolicyDecision,
  ReconcileResult,
  WorkflowLease,
  WorkflowRecord,
} from '@otondev/contracts';
import { FakeServiceBase } from './base.js';
import type { FakeDefaults } from './base.js';
import type { RuntimeContext } from '../runtime.js';
import type {
  AcquireLeaseInput,
  AgentCoreClient,
  AgentStatus,
  AppendAuditInput,
  ApprovalBinding,
  AuditClient,
  CapabilityBrokerClient,
  CapabilityCall,
  ChainVerification,
  CognitionClient,
  ConnectorBrokerClient,
  CreateWorkflowInput,
  IngestOutcome,
  IngressClient,
  PolicyClient,
  PolicyQuery,
  PrepareActionInput,
  RealtimeSession,
  ResourceClaim,
  TransitionInput,
  WebhookDelivery,
  WorkflowEngineClient,
} from '../services/control-plane.js';
import { digestOf, envelopeFor, hexDigestOf, plusSeconds } from './support.js';

/**
 * Minimal in-memory fakes, S1-S8.
 *
 * "Minimal" is the instruction: W0-D "deliberately ships *minimal* fakes. Each Wave-1 owner
 * deepens their own fake as their first commits" (implementation-plan §3). What minimal does
 * *not* mean is "wrong about the invariant the peer depends on". A downstream session builds
 * its retry logic on the fake's behaviour, so the behaviours below are exactly the ones whose
 * absence would send that session down the wrong path:
 *
 *   - ingress returns the *existing* event id for a duplicate;
 *   - the workflow engine compare-and-sets on state_version and fences a stale token;
 *   - the broker runs all seven capability checks;
 *   - the connector refuses to auto-retry an `outcome_unknown` action.
 *
 * Everything else is a Map.
 */

// -------------------------------------------------------------------------------- S1

export class FakeIngress extends FakeServiceBase implements IngressClient {
  readonly serviceId = 'ingress' as const;
  readonly #events = new Map<string, IngressEvent>();
  readonly #byDedupeKey = new Map<string, string>();

  async ingest(delivery: WebhookDelivery): Promise<IngestOutcome> {
    this.assertNotDenied();
    const sourceEventId = delivery.headers['x-event-id'] ?? hexDigestOf(delivery.body).slice(0, 32);
    const key = dedupeKey({
      tenant_id: this.defaults.tenantId,
      system: delivery.system,
      installation_id: delivery.installation_id,
      source_event_id: sourceEventId,
    });

    const existing = this.#byDedupeKey.get(key);
    // Contracts §2. Returning a *new* id here would be the single most damaging thing this
    // fake could do: every downstream dedupe test would then pass against a lie.
    if (existing !== undefined) return { status: 'duplicate', event_id: existing };

    if (delivery.headers['x-signature'] === undefined) {
      return { status: 'rejected', code: 'SIGNATURE_INVALID' };
    }

    const eventId = this.id('event');
    const event: IngressEvent = {
      ...envelopeFor(this.runtime, 'agentdev.event.v2', eventId, this.defaults.tenantId, 'ingress', {
        dataClasses: ['internal_source'],
      }),
      source: {
        system: delivery.system,
        installation_id: delivery.installation_id,
        event_id: sourceEventId,
        occurred_at: delivery.received_at,
        authenticated_principal: delivery.headers['x-principal'] ?? 'unknown',
      },
      kind: delivery.headers['x-kind'] ?? 'ticket.created',
      subject: {
        type: 'ticket',
        id: delivery.headers['x-subject'] ?? 'UNKNOWN-0',
        version: delivery.headers['x-subject-version'] ?? '1',
      },
      payload_ref: this.id('artifact'),
      untrusted_fields: ['description', 'comments'],
      dedupe_key: key,
      received_at: delivery.received_at,
    };

    // Dedupe persistence, then durable store, then acknowledge — in that order (contracts §2).
    this.#byDedupeKey.set(key, eventId);
    this.#events.set(eventId, event);
    return { status: 'accepted', event_id: eventId };
  }

  async getEvent(eventId: string): Promise<IngressEvent | null> {
    return this.#events.get(eventId) ?? null;
  }

  async lookupByDedupeKey(key: string): Promise<string | null> {
    return this.#byDedupeKey.get(key) ?? null;
  }
}

// -------------------------------------------------------------------------------- S2

export class FakeWorkflowEngine extends FakeServiceBase implements WorkflowEngineClient {
  readonly serviceId = 'workflow' as const;
  readonly #workflows = new Map<string, WorkflowRecord>();
  readonly #fencingTokens = new Map<string, number>();

  async create(input: CreateWorkflowInput): Promise<WorkflowRecord> {
    this.assertNotDenied();
    const id = this.id('workflow');
    const record: WorkflowRecord = {
      ...envelopeFor(this.runtime, 'agentdev.workflow.v2', id, input.tenant_id, 'workflow', {
        dataClasses: input.data_classes,
      }),
      agent_id: input.agent_id,
      type: input.type,
      state: 'RECEIVED',
      state_version: 0,
      goal_ref: input.goal_ref,
      source_refs: input.source_refs,
      definition_of_done_ref: input.definition_of_done_ref,
      risk: input.risk,
      data_classes: input.data_classes,
      autonomy_required: input.autonomy_required,
      priority: input.priority,
      budget: input.budget,
      lease: null,
      locks: [],
      attempt: 1,
      next_wakeup_at: null,
      last_checkpoint_ref: null,
    };
    this.#workflows.set(id, record);
    return record;
  }

  async get(workflowId: string): Promise<WorkflowRecord | null> {
    return this.#workflows.get(workflowId) ?? null;
  }

  async transition(input: TransitionInput): Promise<WorkflowRecord> {
    const current = this.#workflows.get(input.workflow_id);
    if (current === undefined) this.fail('INTERNAL', { reason: 'unknown workflow' });

    // Compare-and-set: two claimants, exactly one winner (S2 exit criterion).
    if (current.state_version !== input.expected_state_version) this.fail('STATE_VERSION_CONFLICT');
    if (isTerminal(current.state)) this.fail('WORKFLOW_TERMINAL');
    if (!canTransition(current.state, input.to, input.channel)) this.fail('INVALID_STATE_TRANSITION');

    // A write quoting a superseded fencing token is refused after the fact — which is the
    // whole reason fencing tokens exist rather than lease expiry alone.
    if (input.channel === 'normal' && current.lease !== null) {
      if (input.fencing_token !== current.lease.fencing_token) this.fail('LEASE_FENCED');
    }

    const next: WorkflowRecord = {
      ...current,
      state: input.to,
      state_version: current.state_version + 1,
      lease: input.to === 'PAUSED' || isTerminal(input.to) ? null : current.lease,
    };
    this.#workflows.set(next.id, next);
    return next;
  }

  async acquireLease(input: AcquireLeaseInput): Promise<WorkflowLease> {
    const current = this.#workflows.get(input.workflow_id);
    if (current === undefined) this.fail('INTERNAL', { reason: 'unknown workflow' });

    const nowMs = this.runtime.clock.nowMs();
    const held = current.lease;
    if (held !== null && Date.parse(held.expires_at) > nowMs && held.owner !== input.owner) {
      this.fail('STATE_VERSION_CONFLICT', { reason: 'lease is held by another worker' });
    }

    const token = (this.#fencingTokens.get(input.workflow_id) ?? 0) + 1;
    this.#fencingTokens.set(input.workflow_id, token);
    const lease: WorkflowLease = {
      owner: input.owner,
      expires_at: plusSeconds(this.runtime.clock, input.ttl_seconds),
      fencing_token: token,
    };
    this.#workflows.set(input.workflow_id, { ...current, lease });
    return lease;
  }

  async renewLease(workflowId: string, fencingToken: number, ttlSeconds: number): Promise<WorkflowLease> {
    const current = this.#workflows.get(workflowId);
    if (current == null || current.lease == null) this.fail('LEASE_EXPIRED');
    if (current.lease.fencing_token !== fencingToken) this.fail('LEASE_FENCED');
    const lease: WorkflowLease = {
      ...current.lease,
      expires_at: plusSeconds(this.runtime.clock, ttlSeconds),
    };
    this.#workflows.set(workflowId, { ...current, lease });
    return lease;
  }

  async releaseLease(workflowId: string, fencingToken: number): Promise<void> {
    const current = this.#workflows.get(workflowId);
    if (current == null || current.lease == null) return;
    if (current.lease.fencing_token !== fencingToken) this.fail('LEASE_FENCED');
    this.#workflows.set(workflowId, { ...current, lease: null });
  }

  async scheduleWakeup(workflowId: string, at: string): Promise<void> {
    const current = this.#workflows.get(workflowId);
    if (current === undefined) this.fail('INTERNAL', { reason: 'unknown workflow' });
    this.#workflows.set(workflowId, { ...current, next_wakeup_at: at });
  }

  async recoveryScan(): Promise<string[]> {
    const nowMs = this.runtime.clock.nowMs();
    const due: string[] = [];
    for (const workflow of this.#workflows.values()) {
      if (isTerminal(workflow.state)) continue;
      const leaseExpired = workflow.lease !== null && Date.parse(workflow.lease.expires_at) <= nowMs;
      const wakeupDue = workflow.next_wakeup_at !== null && Date.parse(workflow.next_wakeup_at) <= nowMs;
      if (leaseExpired || wakeupDue) due.push(workflow.id);
    }
    return due;
  }

  /** Containment here means: paused, and the lease dropped so its worker is fenced. */
  override async quarantine(request: Parameters<FakeServiceBase['quarantine']>[0]) {
    const contained: string[] = [];
    for (const workflow of this.#workflows.values()) {
      if (request.scope.kind === 'workflow' && workflow.id !== request.scope.id) continue;
      if (isTerminal(workflow.state)) continue;
      this.#workflows.set(workflow.id, {
        ...workflow,
        state: 'PAUSED',
        state_version: workflow.state_version + 1,
        lease: null,
      });
      contained.push(workflow.id);
    }
    return this.control.ack('contained', contained);
  }
}

// -------------------------------------------------------------------------------- S3

export class FakeAgentCore extends FakeServiceBase implements AgentCoreClient {
  readonly serviceId = 'core' as const;
  readonly #locks = new Map<string, ResourceClaim>();
  readonly #workflow: WorkflowEngineClient;

  constructor(runtime: RuntimeContext, defaults: FakeDefaults, deps: { workflow: WorkflowEngineClient }) {
    super(runtime, defaults);
    this.#workflow = deps.workflow;
  }

  async triage(eventId: string): Promise<{ workflow_id: string; accepted: boolean; reason_codes: string[] }> {
    this.assertNotDenied();
    const workflow = await this.#workflow.create({
      tenant_id: this.defaults.tenantId,
      agent_id: this.defaults.agentId,
      type: 'ticket_delivery',
      goal_ref: this.id('artifact'),
      source_refs: [eventId],
      definition_of_done_ref: 'dod_default_v1',
      risk: 'low',
      data_classes: ['internal_source'],
      autonomy_required: 'A2',
      priority: 50,
      budget: { usd_max: 5, deadline: plusSeconds(this.runtime.clock, 3600), cpu_seconds: 3600 },
    });
    return { workflow_id: workflow.id, accepted: true, reason_codes: ['TRIAGE_ACCEPTED'] };
  }

  async buildPlan(workflowId: string): Promise<Plan> {
    this.assertNotDenied(workflowId);
    const id = this.id('plan');
    return {
      ...envelopeFor(this.runtime, 'agentdev.plan.v2', id, this.defaults.tenantId, 'core', {
        dataClasses: ['internal_source'],
      }),
      workflow_id: workflowId,
      goal_digest: digestOf(workflowId),
      assumptions: [],
      unknowns: [],
      expected_files: [],
      expected_external_effects: [],
      steps: [
        {
          step_id: 's1',
          purpose: 'reproduce',
          action_class: 'worker.command',
          risk: 'low',
          success_condition: 'failing_test_captured',
        },
      ],
      definition_of_done_ref: 'dod_default_v1',
      rollback_or_compensation: { before_publish: 'destroy_workspace', after_publish: 'close_draft_pr' },
      limits: { files_changed: 12, commands: 40, wall_seconds: 7200 },
    };
  }

  async requestDecision(workflowId: string, action: ActionClass): Promise<DecisionRequest> {
    const id = this.id('decisionRequest');
    return {
      ...envelopeFor(this.runtime, 'agentdev.decision_request.v2', id, this.defaults.tenantId, 'core', {
        dataClasses: ['internal_source'],
      }),
      workflow_id: workflowId,
      plan_id: this.id('plan'),
      action,
      resource: 'repo:team/api',
      environment: 'nonprod',
      parameter_digest: digestOf(`${workflowId}:${action}`),
      plan_digest: digestOf(workflowId),
      summary: `Approval requested for ${action}.`,
      blast_radius: 'In-memory fake — no real effect.',
      requested_autonomy: 'A3',
      data_classes: ['internal_source'],
      expires_at: plusSeconds(this.runtime.clock, 900),
      minimum_authn_strength: 'mfa',
    };
  }

  async status(workflowId: string): Promise<AgentStatus> {
    // Derived from workflow truth, never from a cached belief (S3 brief).
    const workflow = await this.#workflow.get(workflowId);
    if (workflow === null) this.fail('INTERNAL', { reason: 'unknown workflow' });
    return {
      workflow_id: workflowId,
      state: workflow.state,
      summary: `state=${workflow.state} attempt=${workflow.attempt}`,
      blocked_on: workflow.state === 'BLOCKED' ? 'no automatic path' : null,
      updated_at: this.runtime.clock.nowIso(),
    };
  }

  async acquireResource(claim: ResourceClaim): Promise<boolean> {
    const held = this.#locks.get(claim.resource);
    if (held !== undefined && held.workflow_id !== claim.workflow_id) {
      // Priority ladder: a higher-priority claim preempts; a lower one is refused outright
      // rather than queued somewhere nobody can see it during an incident.
      if (claim.priority <= held.priority) return false;
    }
    this.#locks.set(claim.resource, claim);
    return true;
  }

  async releaseResource(resource: string, workflowId: string): Promise<void> {
    if (this.#locks.get(resource)?.workflow_id === workflowId) this.#locks.delete(resource);
  }
}

// -------------------------------------------------------------------------------- S4

export class FakePolicy extends FakeServiceBase implements PolicyClient {
  readonly serviceId = 'policy' as const;
  readonly #approvals = new Map<string, Approval>();
  readonly #bundle = `engineering-pilot-v2@sha256:${hexDigestOf('engineering-pilot-v2')}`;
  /** Actions this fake requires approval for. A test widens it to exercise the gate. */
  approvalRequiredFor = new Set<ActionClass>(['staging.deploy', 'git.push']);
  denyAll = false;

  async evaluate(query: PolicyQuery): Promise<PolicyDecision> {
    const id = this.id('policyDecision');
    const decision =
      this.denyAll || this.control.isDenied({ kind: 'global' })
        ? 'deny'
        : this.approvalRequiredFor.has(query.action)
          ? 'require_approval'
          : 'allow';

    return {
      ...envelopeFor(this.runtime, 'agentdev.policy_decision.v2', id, query.tenant_id, 'policy', {
        dataClasses: query.data_classes,
      }),
      subject: { agent_id: query.agent_id, workload_id: query.workload_id },
      action: query.action,
      resource: query.resource,
      environment: query.environment,
      parameter_digest: query.parameter_digest,
      workflow_id: query.workflow_id,
      plan_id: query.plan_id,
      // Incident mode lowers the ceiling. Effective autonomy is a minimum, never a maximum.
      autonomy_level: query.incident_mode === true ? 'A0' : 'A2',
      data_classes: query.data_classes,
      decision,
      policy_bundle: this.#bundle,
      constraints: { max_uses: 1 },
      expires_at: plusSeconds(this.runtime.clock, 900),
      reason_codes: [
        decision === 'allow' ? 'A2_ALLOWED' : decision === 'deny' ? 'DENIED' : 'APPROVAL_REQUIRED',
      ],
    };
  }

  async bundleRef(): Promise<string> {
    return this.#bundle;
  }

  async createApproval(input: Parameters<PolicyClient['createApproval']>[0]): Promise<Approval> {
    const id = this.id('approval');
    const approval: Approval = {
      ...envelopeFor(this.runtime, 'agentdev.approval.v2', id, this.defaults.tenantId, 'policy'),
      approver: input.approver,
      decision_request_id: input.decision_request_id,
      action: input.binding.action,
      resource: input.binding.resource,
      environment: input.binding.environment,
      parameter_digest: input.binding.parameter_digest,
      plan_digest: input.binding.plan_digest,
      expires_at: input.expires_at,
      max_uses: input.max_uses,
      uses: 0,
      status: 'active',
      signature: { alg: 'ed25519', key_id: 'fake-approval-key', value: 'ZmFrZQ' },
    };
    this.#approvals.set(id, approval);
    return approval;
  }

  async consumeApproval(approvalId: string, binding: ApprovalBinding): Promise<Approval> {
    const approval = this.#approvals.get(approvalId);
    if (approval === undefined) this.fail('APPROVAL_BINDING_MISMATCH');
    if (approval.status !== 'active') this.fail('APPROVAL_CONSUMED');
    if (Date.parse(approval.expires_at) <= this.runtime.clock.nowMs()) {
      this.#approvals.set(approvalId, { ...approval, status: 'expired' });
      this.fail('APPROVAL_EXPIRED');
    }
    // Every bound field, every time. "Editing any bound field invalidates an approval" is an
    // S4 exit criterion, so the check iterates the list rather than spot-checking two of them.
    for (const field of ['action', 'resource', 'environment', 'parameter_digest', 'plan_digest'] as const) {
      if (approval[field] !== binding[field]) this.fail('APPROVAL_BINDING_MISMATCH', { field });
    }

    const uses = approval.uses + 1;
    const consumed: Approval = {
      ...approval,
      uses,
      status: uses >= approval.max_uses ? 'consumed' : 'active',
    };
    this.#approvals.set(approvalId, consumed);
    return consumed;
  }

  async getApproval(approvalId: string): Promise<Approval | null> {
    return this.#approvals.get(approvalId) ?? null;
  }
}

// -------------------------------------------------------------------------------- S5

export class FakeCapabilityBroker extends FakeServiceBase implements CapabilityBrokerClient {
  readonly serviceId = 'broker' as const;
  readonly #issued = new Map<string, Capability>();
  readonly #uses = new Map<string, number>();
  readonly #revoked = new Set<string>();

  async mint(request: CapabilityRequest): Promise<Capability> {
    this.assertNotDenied(request.workflow_id);
    const id = this.id('capability');
    const capability: Capability = {
      ...envelopeFor(this.runtime, 'agentdev.capability.v2', id, this.defaults.tenantId, 'broker'),
      subject: request.subject,
      workflow_id: request.workflow_id,
      action_id: request.action_id,
      operation: request.operation,
      resource: request.resource,
      constraints: { parameter_digest: request.parameter_digest, max_uses: request.max_uses },
      lease_fencing_token: request.lease_fencing_token,
      issued_at: this.runtime.clock.nowIso(),
      expires_at: plusSeconds(this.runtime.clock, request.requested_ttl_seconds),
      revocation_epoch: this.control.revocationEpoch,
      broker_signature: { alg: 'ed25519', key_id: 'fake-broker-key', value: 'ZmFrZQ' },
    };
    this.#issued.set(id, capability);
    this.#uses.set(id, 0);
    return capability;
  }

  async verify(capability: Capability, call: CapabilityCall): Promise<CapabilityVerdict> {
    return this.#runMatrix(capability, call);
  }

  async consume(capabilityId: string, call: CapabilityCall): Promise<CapabilityVerdict> {
    const capability = this.#issued.get(capabilityId);
    if (capability === undefined) {
      return {
        valid: false,
        failed_checks: ['signature'],
        capability_id: capabilityId,
        checked_at: this.runtime.clock.nowIso(),
      };
    }
    const verdict = this.#runMatrix(capability, call);
    // Verify and decrement together. Splitting them opens a replay window, and a fake that
    // splits them teaches every downstream session to build one.
    if (verdict.valid) this.#uses.set(capabilityId, (this.#uses.get(capabilityId) ?? 0) + 1);
    return verdict;
  }

  async revokeCapability(capabilityId: string, _reason: string): Promise<void> {
    this.#revoked.add(capabilityId);
  }

  async currentRevocationEpoch(): Promise<number> {
    return this.control.revocationEpoch;
  }

  override async revoke(request: Parameters<FakeServiceBase['revoke']>[0]) {
    const epoch = this.control.bumpRevocationEpoch(request.revocation_epoch);
    // Every capability minted before the bump is now invalid — which is exactly why
    // revocation is an epoch and not a list of ids somebody has to walk while under attack.
    const invalidated = [...this.#issued.values()]
      .filter((capability) => capability.revocation_epoch < epoch)
      .map((capability) => capability.id);
    return this.control.ack('contained', invalidated);
  }

  /** The seven checks from contracts §6, applied in matrix order. */
  #runMatrix(capability: Capability, call: CapabilityCall): CapabilityVerdict {
    const failed: CapabilityCheck[] = [];
    const nowMs = this.runtime.clock.nowMs();

    for (const check of CAPABILITY_CHECKS) {
      switch (check) {
        case 'signature':
          if (capability.broker_signature.key_id !== 'fake-broker-key') failed.push(check);
          break;
        case 'expiry':
          if (Date.parse(capability.expires_at) <= nowMs) failed.push(check);
          break;
        case 'revocation_epoch':
          if (this.#revoked.has(capability.id) || capability.revocation_epoch < this.control.revocationEpoch) {
            failed.push(check);
          }
          break;
        case 'fencing_token':
          if (capability.lease_fencing_token !== call.fencing_token) failed.push(check);
          break;
        case 'use_count':
          if ((this.#uses.get(capability.id) ?? 0) >= capability.constraints.max_uses) failed.push(check);
          break;
        case 'parameter_digest':
          if (capability.constraints.parameter_digest !== call.parameter_digest) failed.push(check);
          break;
        case 'resource':
          if (capability.resource !== call.resource) failed.push(check);
          break;
      }
    }

    return {
      valid: failed.length === 0,
      failed_checks: failed,
      capability_id: capability.id,
      checked_at: this.runtime.clock.nowIso(),
    };
  }
}

// -------------------------------------------------------------------------------- S6

export class FakeCognition extends FakeServiceBase implements CognitionClient {
  readonly serviceId = 'cognition' as const;
  /** Providers a test has forbidden. A forbidden provider fails closed, never falls back. */
  forbiddenProviders = new Set<string>();
  /** Canned structured responses, keyed by `response_schema`. */
  readonly responses = new Map<string, unknown>();
  #spentUsd = 0;

  async generateStructured(request: CognitionRequest): Promise<CognitionResult> {
    this.assertNotDenied(request.workflow_id);
    const allowed = request.provider_constraints.allowed_providers ?? ['local'];
    const provider = allowed.find((candidate) => !this.forbiddenProviders.has(candidate));
    // Fails closed rather than silently falling back to a weaker data policy (S6 criterion).
    if (provider === undefined) this.fail('DATA_PROVIDER_FORBIDDEN');
    if (this.#spentUsd >= request.cost_budget_usd) this.fail('BUDGET_EXHAUSTED');
    this.#spentUsd += 0.001;

    const content = this.responses.get(request.response_schema);
    // A typed error, never prose (S6 exit criterion).
    if (content === undefined) this.fail('STRUCTURED_OUTPUT_INVALID', { schema: request.response_schema });

    const id = this.id('cognitionRequest');
    return {
      ...envelopeFor(this.runtime, 'agentdev.cognition_result.v2', id, request.tenant_id, 'cognition', {
        dataClasses: request.data_classes,
      }),
      request_id: request.id,
      workflow_id: request.workflow_id,
      provider,
      model: 'fake-model',
      model_version: '0',
      prompt_template: { version: 'fake-v1', digest: digestOf('fake-v1') },
      authorized_context_digest: digestOf(request.context_refs.join(',')),
      content,
      schema_verdict: 'valid',
      usage: { input_tokens: 10, output_tokens: 10, cost_usd: 0.001, latency_ms: 1 },
      uncertainty: null,
      citations: [],
      completion_reason: 'stop',
      completed_at: this.runtime.clock.nowIso(),
    };
  }

  async *streamText(request: CognitionRequest): AsyncIterable<string> {
    this.assertNotDenied(request.workflow_id);
    yield 'fake ';
    yield 'stream';
  }

  async realtimeSession(_request: CognitionRequest): Promise<RealtimeSession> {
    return { session_id: this.id('cognitionRequest'), close: async () => {} };
  }

  async embed(texts: readonly string[], _dataClasses: readonly DataClass[]): Promise<number[][]> {
    // Deterministic and content-sensitive, so a similarity assertion means something.
    return texts.map((text) => [text.length, [...text].reduce((n, c) => n + c.charCodeAt(0), 0) % 997]);
  }

  async cancel(_requestId: string): Promise<void> {}
}

// -------------------------------------------------------------------------------- S7

export class FakeConnectorBroker extends FakeServiceBase implements ConnectorBrokerClient {
  readonly serviceId = 'connectors' as const;
  readonly #actions = new Map<string, ExternalAction>();
  readonly #byIdempotencyKey = new Map<string, string>();
  readonly #broker: CapabilityBrokerClient;
  /** Operations the provider answers ambiguously. Drives the `outcome_unknown` path. */
  ambiguousOperations = new Set<string>();
  /** What `reconcile` should report, by action id. Unset means `absent`. */
  readonly remoteState = new Map<string, 'present' | 'absent' | 'indeterminate'>();

  constructor(runtime: RuntimeContext, defaults: FakeDefaults, deps: { broker: CapabilityBrokerClient }) {
    super(runtime, defaults);
    this.#broker = deps.broker;
  }

  async prepare(input: PrepareActionInput): Promise<ExternalAction> {
    this.assertNotDenied(input.workflow_id);
    const id = this.id('action');
    const idempotencyKey = `${this.defaults.tenantId}:${id}`;
    const action: ExternalAction = {
      ...envelopeFor(this.runtime, 'agentdev.action.v2', id, this.defaults.tenantId, 'connectors'),
      workflow_id: input.workflow_id,
      adapter: input.adapter,
      operation: input.operation,
      action_class: input.action_class,
      resource: input.resource,
      parameter_digest: digestOf(JSON.stringify(input.parameters)),
      idempotency_key: idempotencyKey,
      state: 'prepared',
      attempts: 0,
      policy_decision_id: input.policy_decision_id,
      approval_id: input.approval_id ?? null,
      capability_id: this.id('capability'),
      remote_ref: null,
      last_error: null,
      updated_at: this.runtime.clock.nowIso(),
    };
    this.#actions.set(id, action);
    this.#byIdempotencyKey.set(idempotencyKey, id);
    return action;
  }

  async execute(actionId: string, capability: Capability): Promise<ExternalAction> {
    const action = this.#actions.get(actionId);
    if (action === undefined) this.fail('INTERNAL', { reason: 'unknown action' });

    // Contracts §7: automatic retry is forbidden until reconciliation says absent.
    if (!mayAutoRetry(action.state)) this.fail('ACTION_OUTCOME_UNKNOWN', { state: action.state });

    const verdict = await this.#broker.verify(capability, {
      resource: action.resource,
      parameter_digest: action.parameter_digest,
      fencing_token: capability.lease_fencing_token,
    });
    if (!verdict.valid) {
      this.#store({ ...action, state: 'failed', last_error: 'CAPABILITY_INVALID' });
      this.fail('CAPABILITY_PARAMETER_MISMATCH', { failed_checks: verdict.failed_checks.join(',') });
    }

    const attempts = action.attempts + 1;
    if (this.ambiguousOperations.has(action.operation)) {
      this.#store({ ...action, state: 'outcome_unknown', attempts, last_error: 'ACTION_OUTCOME_UNKNOWN' });
      this.fail('ACTION_OUTCOME_UNKNOWN');
    }

    const succeeded: ExternalAction = {
      ...action,
      state: 'succeeded',
      attempts,
      capability_id: capability.id,
      remote_ref: `fake://${action.adapter}/${actionId}`,
    };
    this.#store(succeeded);
    return succeeded;
  }

  async reconcile(actionId: string): Promise<ReconcileResult> {
    const action = this.#actions.get(actionId);
    if (action === undefined) this.fail('INTERNAL', { reason: 'unknown action' });
    const outcome = this.remoteState.get(actionId) ?? 'absent';
    // Only a definite answer moves the action out of `outcome_unknown`. `indeterminate`
    // leaves it exactly where it was, which is what blocks the retry.
    if (outcome === 'absent') this.#store({ ...action, state: 'failed' });
    if (outcome === 'present') this.#store({ ...action, state: 'succeeded', remote_ref: `fake://${actionId}` });
    return {
      action_id: actionId,
      outcome,
      remote_ref: outcome === 'present' ? `fake://${actionId}` : null,
      checked_at: this.runtime.clock.nowIso(),
    };
  }

  async compensate(actionId: string): Promise<ExternalAction> {
    const action = this.#actions.get(actionId);
    if (action === undefined) this.fail('INTERNAL', { reason: 'unknown action' });
    const compensated: ExternalAction = { ...action, state: 'failed' };
    this.#store(compensated);
    return compensated;
  }

  async getAction(actionId: string): Promise<ExternalAction | null> {
    return this.#actions.get(actionId) ?? null;
  }

  #store(action: ExternalAction): void {
    this.#actions.set(action.id, { ...action, updated_at: this.runtime.clock.nowIso() });
  }
}

// -------------------------------------------------------------------------------- S8

export class FakeAudit extends FakeServiceBase implements AuditClient {
  readonly serviceId = 'audit' as const;
  readonly #partitions = new Map<string, AuditRecord[]>();

  async append(input: AppendAuditInput): Promise<AuditRecord> {
    const chain = this.#partitions.get(input.partition) ?? [];
    const previous = chain.at(-1);
    const id = this.id('audit');
    const record: AuditRecord = {
      ...envelopeFor(this.runtime, 'agentdev.audit.v2', id, this.defaults.tenantId, 'audit'),
      component: input.component,
      partition: input.partition,
      sequence: chain.length,
      prev_digest: previous === undefined ? null : hexDigestOf(JSON.stringify(previous)),
      severity: input.severity,
      event: input.event,
      subject_refs: input.subject_refs,
      attributes: input.attributes,
      message: input.message,
      occurred_at: this.runtime.clock.nowIso(),
    };
    chain.push(record);
    this.#partitions.set(input.partition, chain);
    return record;
  }

  async query(filter: { partition: string; since?: string; severity?: AuditSeverity }): Promise<AuditRecord[]> {
    const chain = this.#partitions.get(filter.partition) ?? [];
    return chain.filter(
      (record) =>
        (filter.since === undefined || record.occurred_at >= filter.since) &&
        (filter.severity === undefined || record.severity === filter.severity),
    );
  }

  async verifyChain(partition: string): Promise<ChainVerification> {
    const chain = this.#partitions.get(partition) ?? [];
    for (const [index, record] of chain.entries()) {
      const previous = chain[index - 1];
      const expected = previous === undefined ? null : hexDigestOf(JSON.stringify(previous));
      // An altered or removed record breaks every digest after it. That is the whole design.
      if (record.prev_digest !== expected || record.sequence !== index) {
        return { partition, intact: false, broken_at: index, records_checked: chain.length };
      }
    }
    return { partition, intact: true, broken_at: null, records_checked: chain.length };
  }

  async exportWorm(partition: string): Promise<{ ref: string; digest: string; records: number }> {
    const chain = this.#partitions.get(partition) ?? [];
    return {
      ref: `worm://fake/${partition}`,
      digest: hexDigestOf(JSON.stringify(chain)),
      records: chain.length,
    };
  }

  /** Test seam: alter a stored record so a chain-verification test has something to detect. */
  tamper(partition: string, index: number, message: string): void {
    const chain = this.#partitions.get(partition);
    const record = chain?.[index];
    if (chain === undefined || record === undefined) throw new Error('no such audit record');
    chain[index] = { ...record, message };
  }
}
