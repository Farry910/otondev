import { z } from 'zod';

/**
 * Shared leaf types from contracts §1.
 *
 * "Times use UTC plus original source timestamp/timezone when relevant."
 * "Payload sizes are bounded; large values use encrypted artifact references."
 */

/** RFC3339 in UTC. The platform's own clock is always UTC; no exceptions. */
export const Rfc3339Utc = z.iso.datetime({ offset: false });

/** RFC3339 with an offset — only for a timestamp that came from a source system. */
export const Rfc3339WithOffset = z.iso.datetime({ offset: true });

/**
 * Data classes, ordered. Contracts §1 names `internal` and `internal_source`; the rest is
 * W0's enumeration of the ladder those two sit on.
 *
 * The ordering is load-bearing twice over: the Cognition Gateway routes on data class and
 * the Policy engine's effective autonomy is the *minimum* across agent, repository,
 * environment, data class, incident mode and action type (implementation-plan §5 S4).
 * Adding a member is additive; reordering one is a major bump.
 */
export const DATA_CLASSES = [
  'public',
  'internal',
  'internal_source',
  'customer',
  'confidential',
  'restricted',
  /**
   * Exists so it can be *refused*. Contracts §1: "Secret values are illegal in contracts."
   * Naming the class gives {@link DataClassSet} something to reject, which turns the rule
   * into a validation failure at the boundary instead of a convention a redactor downstream
   * is expected to catch.
   */
  'secret',
] as const;
export const DataClass = z.enum(DATA_CLASSES);
export type DataClass = z.infer<typeof DataClass>;

/** Higher index = more restricted. Used to compute the minimum-autonomy floor. */
export function dataClassRank(value: DataClass): number {
  return DATA_CLASSES.indexOf(value);
}

/** The most restrictive class present. An empty set is a programming error, not `public`. */
export function mostRestrictiveDataClass(classes: readonly DataClass[]): DataClass {
  const first = classes[0];
  if (first === undefined) throw new Error('data_classes must not be empty');
  return classes.reduce((worst, c) => (dataClassRank(c) > dataClassRank(worst) ? c : worst), first);
}

export function isPersistableDataClass(value: DataClass): boolean {
  return value !== 'secret';
}

/**
 * The `data_classes` field of every envelope. Non-empty, and secret-free by construction.
 */
export const DataClassSet = z
  .array(DataClass)
  .min(1)
  .max(DATA_CLASSES.length)
  .refine((classes) => classes.every(isPersistableDataClass), {
    error: 'secret-class data is illegal in a contract payload (contracts §1)',
  });
export type DataClassSet = z.infer<typeof DataClassSet>;

/**
 * Autonomy ladder. A0 = observe only, A4 = act without prior approval within policy.
 * Referenced by contracts §5 (`autonomy_level`) and §3 (`autonomy_required`).
 */
export const AUTONOMY_LEVELS = ['A0', 'A1', 'A2', 'A3', 'A4'] as const;
export const AutonomyLevel = z.enum(AUTONOMY_LEVELS);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

/** Effective autonomy is the minimum across every contributing dimension (S4 brief). */
export function minAutonomy(levels: readonly AutonomyLevel[]): AutonomyLevel {
  const first = levels[0];
  if (first === undefined) throw new Error('autonomy levels must not be empty');
  return levels.reduce((low, l) => (AUTONOMY_LEVELS.indexOf(l) < AUTONOMY_LEVELS.indexOf(low) ? l : low), first);
}

export const RISK_LEVELS = ['low', 'medium', 'high', 'prohibited'] as const;
export const RiskLevel = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const ENVIRONMENTS = ['dev', 'nonprod', 'staging', 'prod'] as const;
export const Environment = z.enum(ENVIRONMENTS);
export type Environment = z.infer<typeof Environment>;

/**
 * Who produced a record. Persisted on every durable record so a rolling upgrade can tell
 * which version wrote what (contracts §12).
 */
export const Producer = z.object({
  service: z.string().min(1).max(64),
  instance: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
});
export type Producer = z.infer<typeof Producer>;

/**
 * "Integrity digests detect accidental/tampered changes; signing is used across trust
 * boundaries where producer identity must be proven." (contracts §1)
 */
export const Integrity = z.object({
  alg: z.literal('sha256'),
  digest: z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex chars'),
});
export type Integrity = z.infer<typeof Integrity>;

export const TraceContext = z.object({
  trace_id: z.string().regex(/^[0-9a-f]{32}$/),
  span_id: z.string().regex(/^[0-9a-f]{16}$/),
});
export type TraceContext = z.infer<typeof TraceContext>;

/**
 * A signature over a record, produced by a named key. The value is a signature, never a
 * key: contracts §1 makes secret values illegal in any contract.
 */
export const Signature = z.object({
  alg: z.enum(['ed25519', 'ecdsa-p256']),
  key_id: z.string().min(1).max(128),
  value: z.string().min(1).max(1024),
});
export type Signature = z.infer<typeof Signature>;

/**
 * Payload bound (contracts §1: "Payload sizes are bounded; large values use encrypted
 * artifact references"). 256 KiB is the largest record we will hold inline; anything bigger
 * becomes an `art_` reference. Ingress enforces it at the edge (S1) and the envelope
 * validator enforces it again on the way in, because the edge is not the only writer.
 */
export const MAX_INLINE_PAYLOAD_BYTES = 256 * 1024;

/** A bounded free-text field. Prose from an untrusted source is data, and data has limits. */
export const BoundedText = (max: number) => z.string().max(max);

/**
 * Time, as a dependency rather than an ambient fact.
 *
 * Leases expire, approvals expire, capabilities expire and the recovery scan fires on a
 * wakeup time. Every one of those is a rule that has to be *tested*, and a service that
 * calls `Date.now()` internally cannot be tested for any of them without sleeping. So the
 * clock is injected: production passes the system clock, tests pass the testkit's fake.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;
  /** RFC3339 in UTC — the format every `*_at` field in this package expects. */
  nowIso(): string;
}
