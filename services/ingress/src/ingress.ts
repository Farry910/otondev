/**
 * S1 — Event Ingress and Dedupe.
 *
 * Contracts §2, stated as one sentence and implemented as one ordering:
 *
 *   "Ingress acknowledges only after authentication, dedupe persistence, and durable enqueue
 *    succeed. Duplicate events return the existing canonical event ID. Out-of-order source
 *    versions are retained but do not silently roll state backward."
 *
 * The whole service is that ordering plus the things that fail closed on the way in. What is
 * worth reading carefully is {@link IngressService.ingest}: every early return is a refusal,
 * and the acknowledgement is unreachable except by passing all of them.
 */

import { createHash } from 'node:crypto';
import { MAX_INLINE_PAYLOAD_BYTES, dedupeKey } from '@otondev/contracts';
import type { Clock, DataClass, ErrorCode, IdFactory, IngressEvent } from '@otondev/contracts';
import { ControlState } from '@otondev/sdk';
import type {
  ControlAck,
  DenyRequest,
  HealthReport,
  IngestOutcome,
  IngressClient,
  QuarantineRequest,
  RevokeRequest,
  ServiceRegistry,
  WebhookDelivery,
} from '@otondev/sdk';
import { header, isExternalSource, sourceRule } from './sources.js';
import type { SourceRule } from './sources.js';
import type { DeliveryAuthenticator } from './authenticator.js';
import type { DedupeLedger, EventQueue, EventStore, PayloadStore, SecretResolver } from './store.js';
import { SubjectVersionLedger } from './versions.js';
import type { VersionVerdict } from './versions.js';

export interface IngressConfig {
  tenantId: string;
  /** How far a delivery's own timestamp may be from now. Outside it, the delivery is a replay. */
  replayWindowSeconds: number;
  maxBodyBytes: number;
  /** Schema major this build emits and accepts. */
  schemaMajor: number;
  instance: string;
  version: string;
}

export const DEFAULT_INGRESS_CONFIG: Omit<IngressConfig, 'tenantId'> = {
  replayWindowSeconds: 300,
  maxBodyBytes: MAX_INLINE_PAYLOAD_BYTES,
  schemaMajor: 2,
  instance: 'ingress-0',
  version: '0.0.0',
};

export interface IngressDeps extends Pick<ServiceRegistry, 'audit'> {
  clock: Clock;
  ids: IdFactory;
  ledger: DedupeLedger;
  events: EventStore;
  payloads: PayloadStore;
  queue: EventQueue;
  secrets: SecretResolver;
  /** Strict by default — see `createIngressService`, and the test that asserts it. */
  authenticator: DeliveryAuthenticator;
  config: IngressConfig;
}

/** What the ingress ledger knows about an event beyond the canonical record. */
export interface IngressMetadata {
  event_id: string;
  dedupe_key: string;
  subject_key: string;
  version_verdict: VersionVerdict;
}

export class IngressService implements IngressClient {
  readonly serviceId = 'ingress' as const;

  readonly #deps: IngressDeps;
  readonly #control: ControlState;
  readonly #versions = new SubjectVersionLedger();
  readonly #metadata = new Map<string, IngressMetadata>();

  constructor(deps: IngressDeps) {
    this.#deps = deps;
    this.#control = new ControlState('ingress', deps.clock);
  }

  /**
   * The ordering that is the contract.
   *
   * Note what happens *after* a successful reservation: if anything later fails, the
   * reservation is released, so the vendor's retry starts clean rather than resuming a
   * half-built event. And note what happens on `resuming`: the same event id is reused, so a
   * crash between persist and ack produces one event, not two.
   */
  async ingest(delivery: WebhookDelivery): Promise<IngestOutcome> {
    if (this.#control.isDenied({ kind: 'global' })) {
      return this.#reject('EMERGENCY_STOP_ACTIVE', delivery, 'ingress is denying new work');
    }

    const rule = sourceRule(delivery.system);

    // ---- size, before anything reads the body ------------------------------------------
    if (delivery.body.byteLength > this.#deps.config.maxBodyBytes) {
      // Checked first: every step below touches the bytes, and an oversized body is a cheap
      // way to make an expensive verifier work hard.
      return this.#reject('PAYLOAD_TOO_LARGE', delivery, `${delivery.body.byteLength} bytes`);
    }

    // ---- schema major ------------------------------------------------------------------
    const declaredMajor = this.#declaredMajor(rule, delivery);
    if (declaredMajor === 'invalid' || !rule.supportedMajors.includes(declaredMajor)) {
      return this.#reject('SCHEMA_MAJOR_UNSUPPORTED', delivery, `major ${String(declaredMajor)}`);
    }

    // ---- authentication and replay window ----------------------------------------------
    const secret = await this.#deps.secrets.secretFor(delivery.system, delivery.installation_id);
    const authentic = this.#deps.authenticator.authenticate(rule, delivery, secret);
    if (!authentic.ok) {
      return this.#reject(authentic.code, delivery, authentic.detail);
    }

    const sourceEventId = header(delivery.headers, rule.eventIdHeader) ?? hexDigest(delivery.body).slice(0, 32);
    const key = dedupeKey({
      tenant_id: this.#deps.config.tenantId,
      system: delivery.system,
      installation_id: delivery.installation_id,
      source_event_id: sourceEventId,
    });

    // ---- dedupe persistence ------------------------------------------------------------
    const reservation = await this.#deps.ledger.reserve(key, () => this.#deps.ids.next('event'), this.#deps.clock.nowIso());
    if (reservation.status === 'committed') {
      // Contracts §2: the *existing* canonical id. Minting a new one here would be the single
      // most damaging thing this service could do.
      return { status: 'duplicate', event_id: reservation.reservation.event_id };
    }

    const eventId = reservation.reservation.event_id;
    try {
      const event = await this.#normalise(rule, delivery, eventId, key, sourceEventId);

      // Store, enqueue, then commit. The enqueue is idempotent on event id, so a resumed
      // reservation re-runs this safely.
      await this.#deps.events.put(event);
      await this.#deps.queue.enqueue(event);
      await this.#deps.ledger.commit(key, this.#deps.clock.nowIso());
      return { status: 'accepted', event_id: eventId };
    } catch (error) {
      // Nothing was acknowledged, so nothing may be left half-reserved: the vendor's retry
      // must be able to start over. Releasing only ever removes an *uncommitted* row.
      await this.#deps.ledger.release(key).catch(() => {
        // A ledger that cannot release will resume the reservation on retry instead, which
        // is the same event id and therefore still correct.
      });
      return this.#reject('INTERNAL', delivery, message(error));
    }
  }

  async getEvent(eventId: string): Promise<IngressEvent | null> {
    return this.#deps.events.get(eventId);
  }

  async lookupByDedupeKey(key: string): Promise<string | null> {
    const reservation = await this.#deps.ledger.get(key);
    // An uncommitted reservation is not an acknowledged event, so it must not be reported as
    // one — the caller would read an id whose record may never exist.
    return reservation !== null && reservation.state === 'committed' ? reservation.event_id : null;
  }

  // --------------------------------------------------------------- ingress-specific reads

  /** Whether this event advanced its subject, or arrived late. Retained either way. */
  metadataFor(eventId: string): IngressMetadata | null {
    return this.#metadata.get(eventId) ?? null;
  }

  highWaterVersion(subjectKey: string): string | null {
    return this.#versions.highWater(subjectKey);
  }

  // ------------------------------------------------------------------------ ServiceClient

  async health(): Promise<HealthReport> {
    return {
      service: this.serviceId,
      status: 'ok',
      denying: this.#control.isDenied({ kind: 'global' }),
      detail: `ingress ${this.#deps.config.version}`,
      checked_at: this.#deps.clock.nowIso(),
    };
  }

  async deny(request: DenyRequest): Promise<ControlAck> {
    this.#control.recordDeny(request);
    // The front door is the whole service: denying ingress stops new work entering the system
    // at all, which is why S18's sequence starts here.
    return this.#control.ack('contained', ['ingress:new-deliveries']);
  }

  async quarantine(request: QuarantineRequest): Promise<ControlAck> {
    this.#control.recordDeny(request);
    this.#control.recordQuarantine(request.scope.id ?? this.serviceId);
    return this.#control.ack('contained', ['ingress:new-deliveries']);
  }

  async revoke(request: RevokeRequest): Promise<ControlAck> {
    this.#control.bumpRevocationEpoch(request.revocation_epoch);
    return this.#control.ack('not_applicable', []);
  }

  // ------------------------------------------------------------------------ internals

  #declaredMajor(rule: SourceRule, delivery: WebhookDelivery): number | 'invalid' {
    const declared = header(delivery.headers, 'x-schema-major');
    // Absent means "the source's current shape", which is what this build's rule describes.
    if (declared === undefined) return this.#deps.config.schemaMajor;
    if (!/^[0-9]+$/.test(declared)) return 'invalid';
    const major = Number(declared);
    return Number.isSafeInteger(major) ? major : 'invalid';
  }

  async #normalise(
    rule: SourceRule,
    delivery: WebhookDelivery,
    eventId: string,
    key: string,
    sourceEventId: string,
  ): Promise<IngressEvent> {
    const artifactId = this.#deps.ids.next('artifact');
    // The payload lives in the artifact store, never inline (contracts §1).
    await this.#deps.payloads.put(delivery.body, artifactId);

    const subjectType = (header(delivery.headers, rule.subjectTypeHeader) ?? rule.defaultSubjectType) as
      IngressEvent['subject']['type'];
    const subjectId = header(delivery.headers, rule.subjectIdHeader) ?? sourceEventId;
    const subjectVersion = header(delivery.headers, rule.subjectVersionHeader) ?? '1';

    const subjectKey = SubjectVersionLedger.key({
      tenant_id: this.#deps.config.tenantId,
      system: delivery.system,
      installation_id: delivery.installation_id,
      subject_type: subjectType,
      subject_id: subjectId,
    });
    const verdict = this.#versions.observe(subjectKey, subjectVersion, delivery.received_at);
    this.#metadata.set(eventId, {
      event_id: eventId,
      dedupe_key: key,
      subject_key: subjectKey,
      version_verdict: verdict,
    });

    const dataClasses: DataClass[] = isExternalSource(delivery.system) ? ['internal_source'] : ['internal'];

    return {
      schema: 'agentdev.event.v2',
      id: eventId,
      tenant_id: this.#deps.config.tenantId,
      correlation_id: this.#deps.ids.next('correlation'),
      created_at: this.#deps.clock.nowIso(),
      producer: {
        service: 'ingress',
        instance: this.#deps.config.instance,
        version: this.#deps.config.version,
      },
      data_classes: dataClasses,
      integrity: { alg: 'sha256', digest: hexDigest(delivery.body) },
      source: {
        system: delivery.system,
        installation_id: delivery.installation_id,
        event_id: sourceEventId,
        occurred_at: sourceOccurredAt(rule, delivery),
        // Who the signature proved this came from — not who typed the text inside it.
        authenticated_principal:
          (rule.principalHeader === null ? undefined : header(delivery.headers, rule.principalHeader)) ??
          `${delivery.system}:${delivery.installation_id}`,
      },
      kind: normaliseKind(header(delivery.headers, rule.kindHeader), rule),
      subject: { type: subjectType, id: subjectId, version: subjectVersion },
      payload_ref: artifactId,
      // Explicitly labelled, from the source's own rule. Never empty by accident.
      untrusted_fields: [...rule.untrustedFields],
      dedupe_key: key,
      received_at: delivery.received_at,
    };
  }

  async #reject(code: ErrorCode, delivery: WebhookDelivery, detail: string): Promise<IngestOutcome> {
    // A refusal at the front door is a security event: it is the earliest signal that
    // something is probing, and it is invisible unless it is recorded.
    await this.#deps.audit
      .append({
        partition: `${this.#deps.config.tenantId}:ingress`,
        severity: code === 'PAYLOAD_TOO_LARGE' ? 'notice' : 'security',
        component: 'ingress',
        event: 'ingress.delivery.rejected',
        subject_refs: [`${delivery.system}:${delivery.installation_id}`],
        attributes: { code, detail },
        message: 'Delivery refused at ingress.',
      })
      .catch(() => {
        // The refusal stands whether or not it could be recorded. Turning an audit outage
        // into an accepted delivery would be exactly the wrong direction to fail in.
      });
    return { status: 'rejected', code };
  }
}

function hexDigest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** `EventSource.occurred_at` keeps the source's own offset (contracts §1). */
function sourceOccurredAt(rule: SourceRule, delivery: WebhookDelivery): string {
  if (rule.timestampHeader !== null) {
    const raw = header(delivery.headers, rule.timestampHeader);
    if (raw !== undefined && !/^[0-9]+$/.test(raw)) {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) return raw;
    }
    if (raw !== undefined && /^[0-9]+$/.test(raw)) {
      return new Date(Number(raw) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
  }
  return delivery.received_at;
}

/** Dotted and source-normalised: `ticket.created`, `pull_request.review_requested`. */
function normaliseKind(raw: string | undefined, rule: SourceRule): string {
  const fallback = `${rule.defaultSubjectType}.received`;
  if (raw === undefined) return fallback;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '_');
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(cleaned) ? cleaned.slice(0, 128) : fallback;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
