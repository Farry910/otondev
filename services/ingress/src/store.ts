/**
 * The `ingress` schema, as ports plus in-memory reference implementations.
 *
 * The dedupe ledger is the interesting one, and it is two-phase for a reason the S1 exit
 * criteria name directly: *a crash between persist and ack neither loses nor duplicates an
 * acknowledged event*.
 *
 * A single-phase ledger cannot satisfy that. Write-then-enqueue loses the event if the
 * process dies before the enqueue; enqueue-then-write duplicates it if the process dies
 * before the write. So the key is **reserved** with its canonical event id before any of the
 * work, and **committed** only after the enqueue is durable. A redelivery of a reserved-but-
 * uncommitted key resumes the same reservation — same event id, re-enqueued idempotently —
 * which is why the vendor retrying after a timeout is safe rather than merely likely to be.
 */

import type { IngressEvent } from '@otondev/contracts';

export type ReservationState = 'reserved' | 'committed';

export interface Reservation {
  dedupe_key: string;
  /** Minted once, at reservation. Every retry of the same delivery gets this same id. */
  event_id: string;
  state: ReservationState;
  reserved_at: string;
  committed_at: string | null;
}

export type ReserveOutcome =
  /** This caller owns the reservation and must complete it. */
  | { status: 'reserved'; reservation: Reservation }
  /** A previous delivery already completed. Return its id; do no work. */
  | { status: 'committed'; reservation: Reservation }
  /**
   * Reserved by an earlier attempt that never committed — a crash, or a concurrent in-flight
   * delivery. The caller resumes it under the *same* event id rather than minting a new one.
   */
  | { status: 'resuming'; reservation: Reservation };

export interface DedupeLedger {
  /** Atomic per key. Two concurrent deliveries of one event must not both get `reserved`. */
  reserve(dedupeKey: string, mintEventId: () => string, at: string): Promise<ReserveOutcome>;
  commit(dedupeKey: string, at: string): Promise<void>;
  /** Abandon a reservation this attempt could not complete, so a retry starts clean. */
  release(dedupeKey: string): Promise<void>;
  get(dedupeKey: string): Promise<Reservation | null>;
}

export interface EventStore {
  put(event: IngressEvent): Promise<void>;
  get(eventId: string): Promise<IngressEvent | null>;
}

/** Raw and normalised payloads live here, never inline on the event (contracts §1). */
export interface PayloadStore {
  put(bytes: Uint8Array, artifactId: string): Promise<void>;
  get(artifactId: string): Promise<Uint8Array | null>;
}

export interface EventQueue {
  /**
   * Durable, and **idempotent on `event.id`**.
   *
   * Idempotency is what makes resuming a crashed reservation safe: the retry re-enqueues the
   * same event id, and the queue must treat that as the same message rather than a second one.
   */
  enqueue(event: IngressEvent): Promise<void>;
}

/** Per-source signing secrets. A port, so a secret is never ambient (contracts §1). */
export interface SecretResolver {
  /** Null means "no secret configured", which fails closed rather than skipping verification. */
  secretFor(system: string, installationId: string): Promise<string | null>;
}

// ------------------------------------------------------------------ reference implementations

export class InMemoryDedupeLedger implements DedupeLedger {
  readonly #rows = new Map<string, Reservation>();

  async reserve(dedupeKey: string, mintEventId: () => string, at: string): Promise<ReserveOutcome> {
    const existing = this.#rows.get(dedupeKey);
    if (existing !== undefined) {
      return existing.state === 'committed'
        ? { status: 'committed', reservation: existing }
        : { status: 'resuming', reservation: existing };
    }
    const reservation: Reservation = {
      dedupe_key: dedupeKey,
      event_id: mintEventId(),
      state: 'reserved',
      reserved_at: at,
      committed_at: null,
    };
    this.#rows.set(dedupeKey, reservation);
    return { status: 'reserved', reservation };
  }

  async commit(dedupeKey: string, at: string): Promise<void> {
    const existing = this.#rows.get(dedupeKey);
    if (existing === undefined) throw new Error(`cannot commit an unreserved key: ${dedupeKey}`);
    if (existing.state === 'committed') return;
    this.#rows.set(dedupeKey, { ...existing, state: 'committed', committed_at: at });
  }

  async release(dedupeKey: string): Promise<void> {
    const existing = this.#rows.get(dedupeKey);
    // Never release a committed row: that would un-acknowledge an acknowledged event and
    // let the next delivery mint a second id for it.
    if (existing !== undefined && existing.state === 'reserved') this.#rows.delete(dedupeKey);
  }

  async get(dedupeKey: string): Promise<Reservation | null> {
    return this.#rows.get(dedupeKey) ?? null;
  }
}

export class InMemoryEventStore implements EventStore {
  readonly #events = new Map<string, IngressEvent>();

  async put(event: IngressEvent): Promise<void> {
    this.#events.set(event.id, event);
  }

  async get(eventId: string): Promise<IngressEvent | null> {
    return this.#events.get(eventId) ?? null;
  }
}

export class InMemoryPayloadStore implements PayloadStore {
  readonly #blobs = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array, artifactId: string): Promise<void> {
    this.#blobs.set(artifactId, bytes);
  }

  async get(artifactId: string): Promise<Uint8Array | null> {
    return this.#blobs.get(artifactId) ?? null;
  }
}

export class InMemoryEventQueue implements EventQueue {
  readonly messages: IngressEvent[] = [];
  readonly #seen = new Set<string>();

  async enqueue(event: IngressEvent): Promise<void> {
    if (this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    this.messages.push(event);
  }
}

/** No secret configured for anything. Useful only where every source is `internal`. */
export class NullSecretResolver implements SecretResolver {
  async secretFor(): Promise<string | null> {
    return null;
  }
}

export class StaticSecretResolver implements SecretResolver {
  readonly #secrets: ReadonlyMap<string, string>;

  constructor(secrets: Readonly<Record<string, string>>) {
    this.#secrets = new Map(Object.entries(secrets));
  }

  async secretFor(system: string, installationId: string): Promise<string | null> {
    return this.#secrets.get(`${system}:${installationId}`) ?? this.#secrets.get(system) ?? null;
  }
}
