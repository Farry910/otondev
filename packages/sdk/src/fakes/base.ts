import { ContractError, makeError } from '@otondev/contracts';
import type { ErrorCode } from '@otondev/contracts';
import { ControlState } from '../hooks.js';
import type {
  ControlAck,
  DenyRequest,
  HealthReport,
  QuarantineRequest,
  RevokeRequest,
  ServiceId,
  ServiceClient,
} from '../hooks.js';
import type { RuntimeContext } from '../runtime.js';

/**
 * The half of every fake that is identical across all twenty services: identity, health, and
 * the W0-E control hooks.
 *
 * Written once because the alternative is twenty implementations of "am I denied?" that
 * differ in exactly the way that matters during an incident. A fake that inherits this gets
 * the deny/quarantine/revoke semantics right for free and overrides only what it can
 * actually contain.
 */
/**
 * Identities a fake stamps on the records it produces.
 *
 * Real records carry a tenant on every envelope because `tenant_id` "is always part of
 * storage keys and authorization checks" (contracts §1). A fake that invented one per record
 * would produce records that individually validate and collectively make no sense, and a
 * cross-tenant isolation test written against it would pass for the wrong reason.
 */
export interface FakeDefaults {
  tenantId: string;
  agentId: string;
  workloadId: string;
}

export abstract class FakeServiceBase implements ServiceClient {
  abstract readonly serviceId: ServiceId;
  protected readonly runtime: RuntimeContext;
  protected readonly defaults: FakeDefaults;
  #control: ControlState | null = null;

  constructor(runtime: RuntimeContext, defaults: FakeDefaults) {
    this.runtime = runtime;
    this.defaults = defaults;
  }

  protected get control(): ControlState {
    // Lazily built: `serviceId` is an abstract member and is not initialised until the
    // subclass constructor has run, so reading it from this constructor would give undefined.
    this.#control ??= new ControlState(this.serviceId, this.runtime.clock);
    return this.#control;
  }

  async health(): Promise<HealthReport> {
    return {
      service: this.serviceId,
      status: 'ok',
      denying: this.control.isDenied({ kind: 'global' }),
      detail: 'in-memory fake',
      checked_at: this.runtime.clock.nowIso(),
    };
  }

  async deny(request: DenyRequest): Promise<ControlAck> {
    this.control.recordDeny(request);
    return this.control.ack('contained', [`${this.serviceId}:new-work`]);
  }

  async quarantine(request: QuarantineRequest): Promise<ControlAck> {
    const id = request.scope.id ?? this.serviceId;
    this.control.recordQuarantine(id);
    return this.control.ack('not_applicable', []);
  }

  async revoke(request: RevokeRequest): Promise<ControlAck> {
    this.control.bumpRevocationEpoch(request.revocation_epoch);
    return this.control.ack('not_applicable', []);
  }

  /**
   * Every mutating method calls this first. A denied service refuses new work — that is what
   * the deny hook is *for*, and a fake that accepts work while denying would let a downstream
   * session build a test that passes for the wrong reason.
   */
  protected assertNotDenied(scopeId?: string): void {
    const denied =
      this.control.isDenied({ kind: 'global' }) ||
      (scopeId !== undefined && this.control.isDenied({ kind: 'workflow', id: scopeId }));
    if (denied) this.fail('EMERGENCY_STOP_ACTIVE');
  }

  protected fail(code: ErrorCode, details?: Record<string, string | number | boolean | null>): never {
    throw new ContractError(
      makeError(code, {
        diagnostic_ref: `fake:${this.serviceId}:${this.runtime.clock.nowIso()}`,
        occurred_at: this.runtime.clock.nowIso(),
        ...(details === undefined ? {} : { details }),
      }),
    );
  }

  protected id(kind: Parameters<RuntimeContext['ids']['next']>[0]): string {
    return this.runtime.ids.next(kind);
  }
}
