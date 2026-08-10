import { createHash, randomFillSync } from 'node:crypto';
import { ContractError, canTransition, isTerminal, makeError, ulid } from '@otondev/contracts';
import type {
  Clock,
  DataClass,
  ErrorCode,
  WorkflowLease,
  WorkflowRecord,
  WorkflowState,
  WorkflowTransition,
  TransitionChannel,
} from '@otondev/contracts';
import { ControlState } from '@otondev/sdk';
import type {
  AcquireLeaseInput,
  ControlAck,
  CreateWorkflowInput,
  DenyRequest,
  HealthReport,
  QuarantineRequest,
  RevokeRequest,
  RuntimeContext,
  TransitionInput,
  WorkflowEngineClient,
} from '@otondev/sdk';
import { DEFAULT_BACKOFF, nextWakeupAt } from './backoff.js';
import type { BackoffPolicy } from './backoff.js';
import { noContainment } from './containment.js';
import type { ContainmentPort } from './containment.js';
import type { Mutator, WorkflowStore } from './store.js';

/**
 * S2 — the workflow engine.
 *
 * Holds no state. Everything durable lives behind {@link WorkflowStore}, so the
 * Temporal-vs-Postgres decision the brief leaves open is a choice of adapter rather than a
 * rewrite, and so the compare-and-set that the whole platform's concurrency rests on happens
 * in exactly one place.
 *
 * The ordering rule that runs through every method: anything asynchronous — denying
 * capabilities, calling a peer — happens **before** the store's critical section, and every
 * check whose answer could change under us is re-evaluated **inside** it. A validation done
 * on a snapshot and trusted after an `await` is the bug this class is shaped to prevent.
 */

export interface CompensationHook {
  /** Free-text name, used in the transition's reason codes so the log says what ran. */
  readonly name: string;
  /**
   * Undo the side effects of an interrupted attempt. Called during recovery, before the
   * workflow resumes, and before a cancel completes.
   *
   * Throwing refuses the recovery: contracts §11 has `COMPENSATION_UNAVAILABLE` precisely so
   * that "we could not undo it" is distinguishable from "there was nothing to undo", and a
   * workflow that resumes over un-compensated external effects is how duplicates happen.
   */
  compensate(record: WorkflowRecord, reason: string): Promise<void>;
}

export interface WorkflowEngineOptions {
  runtime: RuntimeContext;
  store: WorkflowStore;
  /** Defaults to a port that contains nothing — acceptable only before S5 is wired. */
  containment?: ContainmentPort;
  backoff?: BackoffPolicy;
  compensations?: readonly CompensationHook[];
  /** Stamped on operator-channel transitions when the caller does not name themselves. */
  defaultOperator?: string;
}

const PRODUCER_VERSION = '0.0.0';

/**
 * ASSUMPTION (raised as a board request, `board/requests/`).
 *
 * `WorkflowTransition` is an enveloped record and so needs a minted id, but `ID_PREFIX` in
 * `packages/contracts` has no `transition` kind — S2 is the first package to emit one. The
 * envelope's `MintedId` accepts any `<prefix>_<ULID>`, so the record validates, but
 * `ids.next()` cannot produce it.
 *
 * Minting it here rather than borrowing `aud_` or `evt_`: both of those prefixes already mean
 * a different record type, and an id whose prefix lies about what it identifies is worse than
 * one the registry has not heard of yet. When W0 adds the kind this becomes
 * `this.#runtime.ids.next('transition')` and nothing else changes.
 */
const TRANSITION_ID_PREFIX = 'wft_';

export class WorkflowEngine implements WorkflowEngineClient {
  readonly serviceId = 'workflow' as const;

  readonly #runtime: RuntimeContext;
  readonly #store: WorkflowStore;
  readonly #containment: ContainmentPort;
  readonly #backoff: BackoffPolicy;
  readonly #compensations: readonly CompensationHook[];
  readonly #operator: string;
  readonly #control: ControlState;

  constructor(options: WorkflowEngineOptions) {
    this.#runtime = options.runtime;
    this.#store = options.store;
    this.#containment = options.containment ?? noContainment;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#compensations = options.compensations ?? [];
    this.#operator = options.defaultOperator ?? 'system';
    this.#control = new ControlState('workflow', options.runtime.clock);
  }

  get #clock(): Clock {
    return this.#runtime.clock;
  }

  // ------------------------------------------------------------------ lifecycle

  async create(input: CreateWorkflowInput): Promise<WorkflowRecord> {
    this.#assertNotDenied();

    const id = this.#runtime.ids.next('workflow');
    const record: WorkflowRecord = {
      ...this.#envelope(id, input.tenant_id, input.data_classes),
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

    await this.#store.insert(record);
    return record;
  }

  async get(workflowId: string): Promise<WorkflowRecord | null> {
    return this.#store.get(workflowId);
  }

  // ----------------------------------------------------------------- transition

  async transition(input: TransitionInput): Promise<WorkflowRecord> {
    const snapshot = await this.#store.get(input.workflow_id);
    if (snapshot === null) this.#fail('INTERNAL', { reason: 'unknown workflow' });

    const containing = input.to === 'PAUSED' || input.to === 'CANCELLED';

    // A deny refuses *new* work. Containment is not new work — refusing to pause because we
    // are denying would be exactly backwards.
    if (!containing) this.#assertNotDenied(input.workflow_id);

    // Contracts §3: a pause or cancel "completes only after active capabilities are denied,
    // the current lease is fenced or safely checkpointed". Capabilities first, and if the
    // broker will not confirm, the state does not move at all.
    if (containing) {
      const outcome = await this.#containment.denyCapabilities({
        workflow_id: input.workflow_id,
        incident_id: this.#runtime.ids.next('correlation'),
        reason: input.reason_codes.join(',') || `workflow ${input.to.toLowerCase()}`,
        requested_by: this.#operator,
      });

      if (!outcome.denied) {
        await this.#refuse(snapshot, input, 'containment incomplete');
        // ASSUMPTION (raised as a board request): §11 has no code for "a containment
        // precondition could not be satisfied". INTERNAL with a precise detail is the closest
        // honest answer; a CONTAINMENT_INCOMPLETE code would be additive.
        this.#fail('INTERNAL', {
          reason: 'capabilities could not be denied; pause/cancel did not complete',
          detail: outcome.detail,
        });
      }

      if (containing && input.to === 'CANCELLED') {
        await this.#runCompensations(snapshot, `cancelled: ${input.reason_codes.join(',')}`);
      }
    }

    // Every refusal is evidence, not just the version conflict below. The authoritative
    // checks live inside the mutator and signal by throwing, so the only place that can see
    // all of them — terminal, illegal edge, fenced token — is here.
    let outcome;
    try {
      outcome = await this.#store.commit(
        input.workflow_id,
        input.expected_state_version,
        this.#transitionMutator(input),
      );
    } catch (error) {
      if (error instanceof ContractError) {
        await this.#refuse(snapshot, input, error.contract.code);
      }
      throw error;
    }

    if (outcome.status === 'not_found') this.#fail('INTERNAL', { reason: 'unknown workflow' });
    if (outcome.status === 'version_conflict') {
      await this.#refuse(snapshot, input, 'state_version conflict');
      this.#fail('STATE_VERSION_CONFLICT', {
        expected: input.expected_state_version,
        actual: outcome.actual_state_version,
      });
    }

    return outcome.record;
  }

  /**
   * The authoritative validation, run inside the store's critical section.
   *
   * Every check here is also cheap to do on the snapshot above, and doing it there would make
   * the common error paths a little tidier. It is done here instead because the snapshot is
   * stale the instant it is read: between it and the commit, another claimant can have moved
   * the record to a terminal state, taken the lease, or bumped the version. Only the checks
   * performed under the lock are load-bearing.
   */
  #transitionMutator(input: TransitionInput): Mutator {
    return (current) => {
      if (isTerminal(current.state)) this.#fail('WORKFLOW_TERMINAL', { state: current.state });

      if (!canTransition(current.state, input.to, input.channel)) {
        this.#fail('INVALID_STATE_TRANSITION', {
          from: current.state,
          to: input.to,
          channel: input.channel,
        });
      }

      // A write quoting a superseded token is refused after the fact. This is the reason a
      // fencing token exists alongside an expiry: the losing worker does not know it lost.
      if (input.channel === 'normal' && current.lease !== null) {
        if (input.fencing_token !== current.lease.fencing_token) {
          this.#fail('LEASE_FENCED', {
            presented: input.fencing_token ?? null,
            current: current.lease.fencing_token,
          });
        }
      }

      const stateVersion = current.state_version + 1;
      // Fencing the lease *is* the containment step for pause and cancel: dropping it means
      // the worker's next write is rejected even though it never saw the pause.
      const dropLease = input.to === 'PAUSED' || isTerminal(input.to);

      const record: WorkflowRecord = {
        ...current,
        state: input.to,
        state_version: stateVersion,
        lease: dropLease ? null : current.lease,
      };

      return {
        record,
        transition: this.#transitionEvent(current, input, stateVersion, true),
      };
    };
  }

  // --------------------------------------------------------------------- leases

  async acquireLease(input: AcquireLeaseInput): Promise<WorkflowLease> {
    this.#assertNotDenied(input.workflow_id);

    let lease: WorkflowLease | null = null;
    const updated = await this.#store.mutate(input.workflow_id, (current, nextToken) => {
      if (isTerminal(current.state)) this.#fail('WORKFLOW_TERMINAL', { state: current.state });

      const held = current.lease;
      const nowMs = this.#clock.nowMs();
      // A live lease held by somebody else is the one case where exactly one claimant must
      // win. An expired one is free to take, and the old owner is fenced by the new token.
      if (held !== null && Date.parse(held.expires_at) > nowMs && held.owner !== input.owner) {
        this.#fail('STATE_VERSION_CONFLICT', { reason: 'lease is held by another worker' });
      }

      lease = {
        owner: input.owner,
        expires_at: this.#plusSeconds(input.ttl_seconds),
        fencing_token: nextToken(),
      };
      return { ...current, lease };
    });

    if (updated === null || lease === null) this.#fail('INTERNAL', { reason: 'unknown workflow' });
    return lease;
  }

  async renewLease(workflowId: string, fencingToken: number, ttlSeconds: number): Promise<WorkflowLease> {
    let lease: WorkflowLease | null = null;
    const updated = await this.#store.mutate(workflowId, (current) => {
      if (current.lease === null) this.#fail('LEASE_EXPIRED');
      if (current.lease.fencing_token !== fencingToken) {
        this.#fail('LEASE_FENCED', { presented: fencingToken, current: current.lease.fencing_token });
      }
      lease = { ...current.lease, expires_at: this.#plusSeconds(ttlSeconds) };
      return { ...current, lease };
    });

    if (updated === null || lease === null) this.#fail('LEASE_EXPIRED');
    return lease;
  }

  async releaseLease(workflowId: string, fencingToken: number): Promise<void> {
    await this.#store.mutate(workflowId, (current) => {
      if (current.lease === null) return current;
      if (current.lease.fencing_token !== fencingToken) {
        this.#fail('LEASE_FENCED', { presented: fencingToken, current: current.lease.fencing_token });
      }
      return { ...current, lease: null };
    });
  }

  // ------------------------------------------------------- wakeups and recovery

  async scheduleWakeup(workflowId: string, at: string): Promise<void> {
    const updated = await this.#store.mutate(workflowId, (current) => ({
      ...current,
      next_wakeup_at: at,
    }));
    if (updated === null) this.#fail('INTERNAL', { reason: 'unknown workflow' });
  }

  async recoveryScan(): Promise<string[]> {
    return this.#store.due(this.#clock.nowMs());
  }

  /**
   * Schedule the next attempt of a workflow whose attempt was interrupted.
   *
   * Returns false when the backoff policy is exhausted, which the caller reads as "this is
   * not coming back on its own". Silently not scheduling would leave a workflow that looks
   * live and never moves — the worst of the available outcomes.
   */
  async scheduleRetry(workflowId: string): Promise<boolean> {
    let scheduled = false;
    await this.#store.mutate(workflowId, (current) => {
      const attempt = current.attempt + 1;
      const at = nextWakeupAt(attempt, this.#clock.nowMs(), this.#backoff);
      if (at === null) return current;
      scheduled = true;
      return { ...current, attempt, next_wakeup_at: at };
    });
    return scheduled;
  }

  /**
   * Bring an interrupted attempt back to a safe state.
   *
   * Two steps, in this order, because the reverse is how duplicate external effects are
   * created: compensate the interrupted attempt's side effects first, then move the record.
   * The move itself goes through RECOVERING rather than jumping straight back, so the
   * transition log shows an interruption happened rather than an unexplained state change.
   */
  async recover(workflowId: string, resumeTo: WorkflowState): Promise<WorkflowRecord> {
    const snapshot = await this.#store.get(workflowId);
    if (snapshot === null) this.#fail('INTERNAL', { reason: 'unknown workflow' });
    if (isTerminal(snapshot.state)) this.#fail('WORKFLOW_TERMINAL', { state: snapshot.state });

    await this.#runCompensations(snapshot, 'interrupted attempt');

    const recovering = await this.transition({
      workflow_id: workflowId,
      expected_state_version: snapshot.state_version,
      to: 'RECOVERING',
      channel: 'recovery',
      reason_codes: ['INTERRUPTED_ATTEMPT'],
    });

    return this.transition({
      workflow_id: workflowId,
      expected_state_version: recovering.state_version,
      to: resumeTo,
      channel: 'recovery',
      reason_codes: ['RESUMED'],
    });
  }

  async #runCompensations(record: WorkflowRecord, reason: string): Promise<void> {
    for (const hook of this.#compensations) {
      try {
        await hook.compensate(record, reason);
      } catch (error) {
        this.#fail('COMPENSATION_UNAVAILABLE', {
          hook: hook.name,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ------------------------------------------------------------- control hooks

  async health(): Promise<HealthReport> {
    return {
      service: this.serviceId,
      status: 'ok',
      denying: this.#control.isDenied({ kind: 'global' }),
      detail: 'workflow engine',
      checked_at: this.#clock.nowIso(),
    };
  }

  async deny(request: DenyRequest): Promise<ControlAck> {
    this.#control.recordDeny(request);
    return this.#control.ack('contained', ['workflow:new-work']);
  }

  /**
   * Containment for a workflow engine means: paused, and the lease dropped so the worker
   * holding it is fenced. Terminal workflows are skipped rather than reported — there is
   * nothing left to contain, and listing them would make the ack read as though an incident
   * touched more than it did.
   */
  async quarantine(request: QuarantineRequest): Promise<ControlAck> {
    this.#control.recordQuarantine(request.scope.id ?? this.serviceId);

    // `active`, not `due`: an idle workflow — no lease, no wakeup — is invisible to the
    // recovery scan and is exactly as live as a busy one. Containing only the due ones
    // produced an ack that said `contained: []` and looked like success.
    const targets =
      request.scope.kind === 'workflow' && request.scope.id !== undefined
        ? [request.scope.id]
        : await this.#store.active();

    const contained: string[] = [];
    const outstanding: ControlAck['outstanding'] = [];

    for (const id of targets) {
      const record = await this.#store.get(id);
      if (record === null || isTerminal(record.state)) continue;
      try {
        await this.transition({
          workflow_id: id,
          expected_state_version: record.state_version,
          to: 'PAUSED',
          channel: 'operator',
          reason_codes: ['QUARANTINE'],
        });
        contained.push(id);
      } catch (error) {
        outstanding.push({
          subject: id,
          reason: error instanceof ContractError ? error.contract.code : String(error),
        });
      }
    }

    return this.#control.ack(
      outstanding.length === 0 ? 'contained' : 'partial',
      contained,
      outstanding,
    );
  }

  async revoke(request: RevokeRequest): Promise<ControlAck> {
    this.#control.bumpRevocationEpoch(request.revocation_epoch);
    return this.#control.ack('not_applicable', []);
  }

  // ------------------------------------------------------------------- internals

  async #refuse(current: WorkflowRecord, input: TransitionInput, why: string): Promise<void> {
    await this.#store.appendRefusal(
      this.#transitionEvent(current, input, current.state_version, false, why),
    );
  }

  #transitionEvent(
    current: WorkflowRecord,
    input: TransitionInput,
    stateVersion: number,
    accepted: boolean,
    why?: string,
  ): WorkflowTransition {
    const reasonCodes = why === undefined ? input.reason_codes : [...input.reason_codes, why];
    return {
      ...this.#envelope(this.#transitionId(), current.tenant_id, current.data_classes),
      schema: 'agentdev.transition.v2',
      workflow_id: current.id,
      from_state: current.state,
      to_state: input.to,
      state_version: stateVersion,
      channel: input.channel satisfies TransitionChannel,
      accepted,
      reason_codes: reasonCodes.slice(0, 16).map((code) => code.slice(0, 64)),
      fencing_token: input.fencing_token ?? null,
      occurred_at: this.#clock.nowIso(),
    };
  }

  #envelope(id: string, tenantId: string, dataClasses: readonly DataClass[]) {
    return {
      schema: 'agentdev.workflow.v2' as const,
      id,
      tenant_id: tenantId,
      correlation_id: this.#runtime.ids.next('correlation'),
      created_at: this.#clock.nowIso(),
      producer: { service: 'workflow' as const, instance: 'workflow-engine', version: PRODUCER_VERSION },
      data_classes: [...dataClasses] as DataClass[],
      integrity: {
        alg: 'sha256' as const,
        digest: createHash('sha256').update(id).digest('hex'),
      },
    };
  }

  #transitionId(): string {
    const randomness = new Uint8Array(10);
    randomFillSync(randomness);
    return TRANSITION_ID_PREFIX + ulid(this.#clock.nowMs(), randomness);
  }

  #plusSeconds(seconds: number): string {
    return new Date(this.#clock.nowMs() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  #assertNotDenied(workflowId?: string): void {
    const denied =
      this.#control.isDenied({ kind: 'global' }) ||
      (workflowId !== undefined && this.#control.isDenied({ kind: 'workflow', id: workflowId }));
    if (denied) this.#fail('EMERGENCY_STOP_ACTIVE');
  }

  #fail(code: ErrorCode, details?: Record<string, string | number | boolean | null>): never {
    throw new ContractError(
      makeError(code, {
        diagnostic_ref: `workflow:${this.#clock.nowIso()}`,
        occurred_at: this.#clock.nowIso(),
        ...(details === undefined ? {} : { details }),
      }),
    );
  }
}
