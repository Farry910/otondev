import { ContractError, makeError } from '@otondev/contracts';
import type { Approval, Clock, ErrorCode, IdFactory, PolicyDecision } from '@otondev/contracts';
import { ControlState } from '@otondev/sdk';
import type {
  ApprovalBinding,
  AuditClient,
  ControlAck,
  DenyRequest,
  HealthReport,
  PolicyClient,
  QuarantineRequest,
  RevokeRequest,
} from '@otondev/sdk';
import { loadBundle } from './bundle.js';
import type { LoadedBundle } from './bundle.js';
import { checkConsumable, consumed } from './approvals.js';
import { evaluate } from './evaluate.js';
import type { ApprovalVerdict, PolicyEvaluationQuery } from './evaluate.js';
import { makeEnvelope } from './envelope.js';
import { InMemoryPolicyStore } from './store.js';
import type { PolicyStore } from './store.js';
import type { ReasonCode } from './reasons.js';

/**
 * S4 — the Policy and Approval service.
 *
 * Everything decision-shaped is delegated to the pure functions in `evaluate.ts` and
 * `approvals.ts`. What lives here is the part that touches the world: loading a verified
 * bundle, reading and writing approvals under compare-and-set, stamping contract envelopes,
 * and recording every decision for audit.
 *
 * Keeping that split sharp is what makes the S4 exit criteria testable. "Every decision is
 * reproducible from its logged inputs and bundle hash" is a property of a pure function; it
 * would be an aspiration if the same code also had to consult a clock and a database.
 */

/**
 * The authentication strengths that can produce an approval at all.
 *
 * Contracts §5: free-form yes, an emoji, a ticket label, chat text and model output are not
 * approvals. None of those can present one of these, and there is no code path in this
 * service that reads prose and decides it meant yes — so the rule is enforced by the absence
 * of a mechanism rather than by a filter somebody has to keep ahead of.
 */
const APPROVAL_CAPABLE_AUTHN = new Set(['mfa', 'hardware_key', 'signed_command']);

export interface PolicyServiceConfig {
  tenantId: string;
  clock: Clock;
  ids: IdFactory;
  /** Verified at construction. An unsigned or untrusted bundle throws rather than loading. */
  bundle: unknown;
  trustedKeys: ReadonlyMap<string, string>;
  audit: AuditClient;
  store?: PolicyStore;
  instance?: string;
  version?: string;
}

export class PolicyService implements PolicyClient {
  readonly serviceId = 'policy' as const;

  readonly #config: PolicyServiceConfig;
  readonly #store: PolicyStore;
  readonly #bundle: LoadedBundle;
  readonly #control: ControlState;
  readonly #envelope: Parameters<typeof makeEnvelope>[0];

  constructor(config: PolicyServiceConfig) {
    this.#config = config;
    this.#store = config.store ?? new InMemoryPolicyStore();
    // Load eagerly. A service that starts with an unverified bundle and fails on the first
    // decision has already told a scheduler it is healthy.
    this.#bundle = loadBundle(config.bundle, config.trustedKeys);
    this.#control = new ControlState('policy', config.clock);
    this.#envelope = {
      clock: config.clock,
      ids: config.ids,
      service: 'policy',
      instance: config.instance ?? 'policy-1',
      version: config.version ?? '0.0.0',
    };
  }

  // ------------------------------------------------------------------ ServiceClient

  async health(): Promise<HealthReport> {
    return {
      service: 'policy',
      status: 'ok',
      denying: this.#control.isDenied({ kind: 'global' }),
      detail: `bundle ${this.#bundle.ref} signed by ${this.#bundle.keyId}`,
      checked_at: this.#config.clock.nowIso(),
    };
  }

  /**
   * Denying policy is the strongest containment there is: nothing downstream can obtain a
   * capability without an allow, so a denied policy service stops the whole plane issuing
   * new authority. It does not revoke authority already granted — that is the broker's epoch.
   */
  async deny(request: DenyRequest): Promise<ControlAck> {
    this.#control.recordDeny(request);
    return this.#control.ack('contained', ['policy:new-decisions']);
  }

  async quarantine(_request: QuarantineRequest): Promise<ControlAck> {
    // Policy holds no workload to isolate. Saying so is the honest ack; a `contained` here
    // would let an operator believe something was stopped that never existed.
    return this.#control.ack('not_applicable', []);
  }

  async revoke(request: RevokeRequest): Promise<ControlAck> {
    // Approvals are authority. Revoking marks every live one so a replay cannot ride an
    // approval issued before the incident.
    const live = await this.#store.listApprovals(this.#config.tenantId);
    const revoked: string[] = [];
    for (const approval of live) {
      if (approval.status !== 'active') continue;
      await this.#store.putApproval({ ...approval, status: 'revoked' });
      revoked.push(approval.id);
    }
    this.#control.bumpRevocationEpoch(request.revocation_epoch);
    return this.#control.ack('contained', revoked);
  }

  // ------------------------------------------------------------------ PolicyClient

  async bundleRef(): Promise<string> {
    return this.#bundle.ref;
  }

  async evaluate(query: PolicyEvaluationQuery): Promise<PolicyDecision> {
    const approval = await this.#resolveApproval(query);
    const outcome = evaluate({ bundle: this.#bundle.body, query, approval });

    // A denied service denies. Applied after evaluation rather than before so the audit
    // record still shows what the bundle would have said, which is what an incident review
    // needs in order to tell containment apart from a policy change.
    const denied = this.#control.isDenied({ kind: 'global' });
    const decision = denied ? 'deny' : outcome.decision;
    const reasonCodes: ReasonCode[] = denied
      ? (['DENIED_UNKNOWN_INPUT'] satisfies ReasonCode[])
      : outcome.reason_codes;

    const id = this.#config.ids.next('policyDecision');
    const record: PolicyDecision = {
      ...makeEnvelope(this.#envelope, 'agentdev.policy_decision.v2', id, query.tenant_id, {
        agentId: query.agent_id,
        workflowId: query.workflow_id,
        dataClasses: query.data_classes,
      }),
      subject: { agent_id: query.agent_id, workload_id: query.workload_id },
      action: query.action,
      resource: query.resource,
      environment: query.environment,
      parameter_digest: query.parameter_digest,
      workflow_id: query.workflow_id,
      plan_id: query.plan_id,
      autonomy_level: denied ? 'A0' : outcome.autonomy_level,
      data_classes: [...query.data_classes],
      decision,
      policy_bundle: this.#bundle.ref,
      constraints: outcome.constraints,
      expires_at: this.#plusSeconds(900),
      reason_codes: reasonCodes,
    };

    await this.#audit('policy.decision.recorded', 'security', [record.id, record.resource], {
      decision: record.decision,
      autonomy_level: record.autonomy_level,
      action: record.action,
      environment: record.environment,
      // The binding dimensions are what make the number checkable after the fact.
      bound_by: outcome.binding_dimensions.map((d) => `${d.dimension}=${d.source}`).join(','),
    });

    return record;
  }

  async createApproval(input: Parameters<PolicyClient['createApproval']>[0]): Promise<Approval> {
    if (!APPROVAL_CAPABLE_AUTHN.has(input.approver.authn_strength)) {
      // The structural half of "chat text is not an approval".
      this.#fail('APPROVAL_BINDING_MISMATCH', {
        reason: 'authn_strength',
        supplied: input.approver.authn_strength,
      });
    }
    if (input.max_uses < 1) {
      this.#fail('APPROVAL_BINDING_MISMATCH', { reason: 'max_uses must be at least 1' });
    }
    if (Date.parse(input.expires_at) <= this.#config.clock.nowMs()) {
      this.#fail('APPROVAL_EXPIRED', { reason: 'expiry is not in the future' });
    }

    const id = this.#config.ids.next('approval');
    const approval: Approval = {
      ...makeEnvelope(this.#envelope, 'agentdev.approval.v2', id, this.#config.tenantId, {
        dataClasses: ['internal'],
      }),
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
      signature: { alg: 'ed25519', key_id: 'policy-approval-key', value: 'unsigned-in-this-build' },
    };

    await this.#store.putApproval(approval);
    await this.#audit('policy.approval.created', 'security', [approval.id, approval.resource], {
      action: approval.action,
      environment: approval.environment,
      authn_strength: approval.approver.authn_strength,
      max_uses: approval.max_uses,
    });
    return approval;
  }

  async consumeApproval(approvalId: string, binding: ApprovalBinding): Promise<Approval> {
    const approval = await this.#store.getApproval(this.#config.tenantId, approvalId);
    if (approval === null) this.#fail('APPROVAL_BINDING_MISMATCH', { reason: 'no such approval' });

    const rule = this.#bundle.body.rules.find((candidate) => candidate.action === binding.action);
    const check = checkConsumable({
      approval,
      binding,
      now: this.#config.clock.nowIso(),
      ...(rule === undefined ? {} : { requiredAuthnStrength: rule.minimum_authn_strength }),
    });

    if (!check.ok) {
      await this.#audit('policy.approval.refused', 'security', [approvalId], {
        reason: check.reason,
        ...(check.field === undefined ? {} : { field: check.field }),
      });
      this.#fail(REASON_TO_ERROR[check.reason] ?? 'APPROVAL_BINDING_MISMATCH', {
        reason: check.reason,
      });
    }

    // Compare-and-set on the use count. Two callers presenting the same single-use approval
    // race here, and exactly one of them wins — which is the whole point of a `max_uses` of 1.
    const next = consumed(approval);
    const stored = await this.#store.compareAndSetApproval(next, approval.uses);
    if (stored === null) {
      await this.#audit('policy.approval.refused', 'security', [approvalId], { reason: 'RACE_LOST' });
      this.#fail('APPROVAL_CONSUMED', { reason: 'another caller consumed it first' });
    }

    await this.#audit('policy.approval.consumed', 'security', [approvalId, stored.resource], {
      uses: stored.uses,
      max_uses: stored.max_uses,
      result: stored.status,
    });
    return stored;
  }

  async getApproval(approvalId: string): Promise<Approval | null> {
    return this.#store.getApproval(this.#config.tenantId, approvalId);
  }

  // ------------------------------------------------------------------ internals

  async #resolveApproval(query: PolicyEvaluationQuery): Promise<ApprovalVerdict> {
    if (query.approval_id === undefined) return { present: false };

    const approval = await this.#store.getApproval(query.tenant_id, query.approval_id);
    if (approval === null) {
      return { present: true, valid: false, approvalId: query.approval_id, reason: 'APPROVAL_NOT_FOUND' };
    }

    const rule = this.#bundle.body.rules.find((candidate) => candidate.action === query.action);
    const check = checkConsumable({
      approval,
      binding: {
        action: query.action,
        resource: query.resource,
        environment: query.environment,
        parameter_digest: query.parameter_digest,
        plan_digest: approval.plan_digest,
      },
      now: this.#config.clock.nowIso(),
      ...(rule === undefined ? {} : { requiredAuthnStrength: rule.minimum_authn_strength }),
    });

    return check.ok
      ? { present: true, valid: true, approvalId: approval.id }
      : { present: true, valid: false, approvalId: approval.id, reason: check.reason };
  }

  async #audit(
    event: string,
    severity: 'info' | 'notice' | 'security' | 'emergency',
    subjects: string[],
    attributes: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    try {
      await this.#config.audit.append({
        partition: `${this.#config.tenantId}:policy`,
        severity,
        component: 'policy',
        event,
        subject_refs: subjects,
        attributes,
        message: 'Policy decision recorded.',
        });
    } catch {
      // Audit is a peer and peers fail. A policy decision that already happened must not be
      // retracted because the record of it could not be written — but the gap has to be
      // visible, so the failure surfaces through health rather than being swallowed here.
      // (S8 owns durable buffering; this service must not invent its own.)
    }
  }

  #plusSeconds(seconds: number): string {
    return new Date(this.#config.clock.nowMs() + seconds * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
  }

  #fail(code: ErrorCode, details: Record<string, string | number | boolean | null>): never {
    throw new ContractError(
      makeError(code, {
        diagnostic_ref: `policy:${this.#config.clock.nowIso()}`,
        occurred_at: this.#config.clock.nowIso(),
        details,
      }),
    );
  }
}

/** Reason codes map onto the frozen error contract; anything unmapped is a binding failure. */
const REASON_TO_ERROR: Partial<Record<ReasonCode, ErrorCode>> = {
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_CONSUMED: 'APPROVAL_CONSUMED',
  APPROVAL_REVOKED: 'APPROVAL_CONSUMED',
  APPROVAL_BINDING_MISMATCH: 'APPROVAL_BINDING_MISMATCH',
  APPROVAL_AUTHN_TOO_WEAK: 'APPROVAL_BINDING_MISMATCH',
  APPROVAL_NOT_FOUND: 'APPROVAL_BINDING_MISMATCH',
};
