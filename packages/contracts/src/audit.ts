import { z } from 'zod';
import { envelopeExtend } from './envelope.js';
import { AnyRef } from './ids.js';
import { BoundedText, Rfc3339Utc } from './primitives.js';
import { Component } from './errors.js';

/**
 * Audit record (S8).
 *
 * Not in contracts-and-data.md as a numbered section, but every package brief's exit
 * criteria reference audit events, so the shape belongs in the frozen surface rather than in
 * S8's source where nobody else can see it.
 *
 * The hash chain is the point. `prev_digest` links each record to the one before it in the
 * same partition, so removing or altering a record breaks verification for everything after
 * it. A log you can quietly edit is a log that proves nothing during the one week it matters.
 */

export const AUDIT_SEVERITIES = ['info', 'notice', 'security', 'emergency'] as const;
export const AuditSeverity = z.enum(AUDIT_SEVERITIES);
export type AuditSeverity = z.infer<typeof AuditSeverity>;

/**
 * Severities that are never sampled away. Operations requires 100% retention of A3-autonomy
 * actions, security events, policy decisions and emergency events.
 */
export const NEVER_SAMPLED_SEVERITIES = ['security', 'emergency'] as const;

export const AuditRecord = envelopeExtend({
  schema: z.literal('agentdev.audit.v2'),
  /** Chain partition. Records only chain within one partition, so writers can parallelise. */
  partition: z.string().min(1).max(128),
  /** Monotonic within the partition, gap-free. A gap is a tampering signal. */
  sequence: z.number().int().nonnegative(),
  /** Digest of the previous record in this partition; null only for the first. */
  prev_digest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  severity: AuditSeverity,
  component: Component,
  /** Dotted event name, e.g. `policy.decision.recorded`. Enumerable, not free text. */
  event: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).max(128),
  /** What the event is about. References, not payloads. */
  subject_refs: z.array(AnyRef).max(32),
  /** Structured detail. Redacted at construction; a secret-class key cannot survive it. */
  attributes: z.record(
    z.string().max(64),
    z.union([z.string().max(512), z.number(), z.boolean(), z.null()]),
  ),
  /** Human-readable, bounded, and never assembled from a provider response. */
  message: BoundedText(512),
  occurred_at: Rfc3339Utc,
});
export type AuditRecord = z.infer<typeof AuditRecord>;

/**
 * Metric label keys that are permitted. Anything not on this list is unbounded in practice.
 *
 * S8's exit criterion — "ticket IDs, prompts, filenames, and people never become metric
 * labels" — is a property of the registry, not of anyone's discipline, so the allow-list
 * lives in the contract and the SDK's metric helpers refuse everything else.
 */
export const ALLOWED_METRIC_LABELS = [
  'tenant_id',
  'component',
  'operation',
  'action_class',
  'adapter',
  'provider',
  'model',
  'result',
  'error_code',
  'severity',
  'state',
  'environment',
  'data_class',
  'autonomy_level',
  'risk',
] as const;
export type AllowedMetricLabel = (typeof ALLOWED_METRIC_LABELS)[number];

const ALLOWED_METRIC_LABEL_SET = new Set<string>(ALLOWED_METRIC_LABELS);

export function isAllowedMetricLabel(name: string): name is AllowedMetricLabel {
  return ALLOWED_METRIC_LABEL_SET.has(name);
}
