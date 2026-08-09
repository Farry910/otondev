import type { Clock } from '@otondev/contracts';

/**
 * W0-E — the emergency-stop hooks every service implements.
 *
 * S18's exit criteria are the reason this lives in Wave 0 rather than in the operator
 * service: "the six-step emergency sequence completes in order", "deny propagates at p95
 * < 10 s", and — the one that decides the shape below — "containment is *verified*, not
 * merely requested".
 *
 * Verified containment means an ack has to carry evidence. A hook that returns `void` gives
 * the operator no way to distinguish "stopped" from "the message was delivered to a process
 * that is now wedged", and during an incident that is the only distinction that matters. So
 * every hook returns a {@link ControlAck} naming what it actually stopped, and an
 * unreachable service produces an explicit `unreachable` ack rather than a silence the
 * aggregator has to interpret.
 *
 * Three verbs, because they contain different things and fail differently:
 *
 *   deny       — refuse *new* work and *new* capabilities. Cheap, instant, reversible.
 *   quarantine — isolate something already running. Slower; may need a workspace teardown.
 *   revoke     — invalidate authority already granted. Must survive the control plane being
 *                unreachable, which is why it is expressed as an epoch rather than a list.
 */

export type ControlScopeKind = 'tenant' | 'agent' | 'workflow' | 'workload' | 'workspace' | 'global';

export interface ControlScope {
  kind: ControlScopeKind;
  /** Absent only for `global`. */
  id?: string;
}

export interface ControlRequest {
  /** Ties every hook call in one emergency sequence together in the audit log. */
  incident_id: string;
  scope: ControlScope;
  /** Free text for the human record. Never parsed, never used for a decision. */
  reason: string;
  /** Out-of-band authenticated operator, or the policy engine acting on a revocation. */
  requested_by: string;
  requested_at: string;
}

export type DenyRequest = ControlRequest;

export interface QuarantineRequest extends ControlRequest {
  /** Whether to keep the workspace for forensics. Defaults to keeping it. */
  preserve_for_forensics?: boolean;
}

export interface RevokeRequest extends ControlRequest {
  /**
   * Revoking to an epoch rather than by capability id is what makes this work when the
   * control plane is degraded: a verifier that knows the current epoch can reject every
   * older capability without asking anyone.
   */
  revocation_epoch: number;
}

export type ControlOutcome = 'contained' | 'partial' | 'not_applicable' | 'unreachable' | 'failed';

export interface ControlAck {
  service: ServiceId;
  outcome: ControlOutcome;
  /**
   * What was actually stopped: workflow ids paused, capabilities invalidated, workspaces
   * torn down. Empty with `contained` means "nothing here to contain", which is a different
   * and much better answer than "done".
   */
  contained: string[];
  /** What could not be contained, and why. Present whenever the outcome is not `contained`. */
  outstanding: { subject: string; reason: string }[];
  observed_at: string;
  latency_ms: number;
}

export interface ControlHooks {
  deny(request: DenyRequest): Promise<ControlAck>;
  quarantine(request: QuarantineRequest): Promise<ControlAck>;
  revoke(request: RevokeRequest): Promise<ControlAck>;
}

export const SERVICE_IDS = [
  'ingress', // S1
  'workflow', // S2
  'core', // S3
  'policy', // S4
  'broker', // S5
  'cognition', // S6
  'connectors', // S7
  'audit', // S8
  'evidence', // S9
  'workspace', // S10
  'executor', // S11
  'verifier', // S12
  'memory', // S13
  'memory-store', // S14
  'presence', // S15
  'companion', // S16
  'supervisor', // S17
  'operator', // S18
  'eval', // S19
  'integration', // S20
] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export interface HealthReport {
  service: ServiceId;
  status: 'ok' | 'degraded' | 'down';
  /** Set while a deny is in force. A healthy service that is denying is not "ok". */
  denying: boolean;
  detail: string;
  checked_at: string;
}

/**
 * The contract every S1-S20 client satisfies. Two members beyond the hooks, both of which
 * the operator console and the integration harness need from every peer uniformly.
 */
export interface ServiceClient extends ControlHooks {
  readonly serviceId: ServiceId;
  health(): Promise<HealthReport>;
}

/**
 * The state machine behind a service's own deny/quarantine/revoke handling.
 *
 * Extracted because twenty services implementing "am I currently denied, and does this scope
 * match?" twenty times would produce twenty subtly different answers to the question an
 * incident turns on. A service composes this and adds only what it can actually contain.
 */
export class ControlState {
  #denials: DenyRequest[] = [];
  #quarantined = new Set<string>();
  #revocationEpoch = 0;
  readonly #clock: Clock;
  readonly #service: ServiceId;

  constructor(service: ServiceId, clock: Clock) {
    this.#service = service;
    this.#clock = clock;
  }

  get revocationEpoch(): number {
    return this.#revocationEpoch;
  }

  /** Does any active denial cover `scope`? A global denial covers everything. */
  isDenied(scope: ControlScope): boolean {
    return this.#denials.some((denial) => scopeCovers(denial.scope, scope));
  }

  isQuarantined(id: string): boolean {
    return this.#quarantined.has(id);
  }

  recordDeny(request: DenyRequest): void {
    this.#denials.push(request);
  }

  recordQuarantine(id: string): void {
    this.#quarantined.add(id);
  }

  /** Monotonic. An epoch that could move backwards would un-revoke a capability. */
  bumpRevocationEpoch(to?: number): number {
    this.#revocationEpoch = Math.max(this.#revocationEpoch + 1, to ?? 0);
    return this.#revocationEpoch;
  }

  lift(incidentId: string): void {
    this.#denials = this.#denials.filter((denial) => denial.incident_id !== incidentId);
  }

  ack(outcome: ControlOutcome, contained: string[], outstanding: ControlAck['outstanding'] = []): ControlAck {
    return {
      service: this.#service,
      outcome,
      contained,
      outstanding,
      observed_at: this.#clock.nowIso(),
      latency_ms: 0,
    };
  }
}

/** `global` covers everything; `tenant:x` covers `agent` and `workflow` only if told so. */
export function scopeCovers(outer: ControlScope, inner: ControlScope): boolean {
  if (outer.kind === 'global') return true;
  return outer.kind === inner.kind && outer.id === inner.id;
}

/**
 * Fan a hook out across every registered service and assemble the containment report.
 *
 * Aggregation belongs here rather than in S18 for one reason: the report must include
 * services that did not answer. An aggregator built from `Promise.all` drops the
 * unreachable ones — the exact services an operator most needs to know about.
 */
export interface ContainmentReport {
  incident_id: string;
  acks: ControlAck[];
  /** True only when every service returned `contained` or `not_applicable`. */
  contained: boolean;
  unreachable: ServiceId[];
  slowest_ms: number;
  started_at: string;
  completed_at: string;
}

export interface FanOutOptions {
  clock: Clock;
  /** A service that has not answered by then is reported unreachable, not awaited. */
  timeoutMs?: number;
  /** Injected so tests can measure without a real clock. Defaults to `performance.now`. */
  monotonicMs?: () => number;
}

export async function fanOutControlHook(
  hook: 'deny' | 'quarantine' | 'revoke',
  services: readonly (ServiceClient & Record<string, unknown>)[],
  request: DenyRequest & Partial<RevokeRequest> & Partial<QuarantineRequest>,
  options: FanOutOptions,
): Promise<ContainmentReport> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const monotonic = options.monotonicMs ?? (() => performance.now());
  const startedAt = options.clock.nowIso();

  const acks = await Promise.all(
    services.map(async (service): Promise<ControlAck> => {
      const started = monotonic();
      try {
        const ack = await withDeadline(
          invokeHook(service, hook, request),
          timeoutMs,
          () =>
            ({
              service: service.serviceId,
              outcome: 'unreachable',
              contained: [],
              outstanding: [{ subject: service.serviceId, reason: `no answer within ${timeoutMs}ms` }],
              observed_at: options.clock.nowIso(),
              latency_ms: monotonic() - started,
            }) satisfies ControlAck,
        );
        return { ...ack, latency_ms: monotonic() - started };
      } catch (error) {
        return {
          service: service.serviceId,
          outcome: 'failed',
          contained: [],
          outstanding: [
            { subject: service.serviceId, reason: error instanceof Error ? error.message : String(error) },
          ],
          observed_at: options.clock.nowIso(),
          latency_ms: monotonic() - started,
        };
      }
    }),
  );

  return {
    incident_id: request.incident_id,
    acks,
    contained: acks.every((a) => a.outcome === 'contained' || a.outcome === 'not_applicable'),
    unreachable: acks.filter((a) => a.outcome === 'unreachable').map((a) => a.service),
    slowest_ms: acks.reduce((max, a) => Math.max(max, a.latency_ms), 0),
    started_at: startedAt,
    completed_at: options.clock.nowIso(),
  };
}

function invokeHook(
  service: ControlHooks,
  hook: 'deny' | 'quarantine' | 'revoke',
  request: DenyRequest & Partial<RevokeRequest> & Partial<QuarantineRequest>,
): Promise<ControlAck> {
  switch (hook) {
    case 'deny':
      return service.deny(request);
    case 'quarantine':
      return service.quarantine(request);
    case 'revoke':
      return service.revoke({ ...request, revocation_epoch: request.revocation_epoch ?? 0 });
  }
}

async function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
