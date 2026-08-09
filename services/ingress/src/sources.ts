/**
 * Per-source webhook rules: how a delivery is authenticated, and how it is normalised.
 *
 * One table per source system rather than one code path with flags. Every source signs
 * differently, names its event id differently, and puts attacker-controlled prose in a
 * different place — and the last of those is a security property, not a formatting detail.
 * A shared code path with per-source branches is where "GitHub's `body` is untrusted" quietly
 * stops applying to Jira.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EventSubject, IngressEvent } from '@otondev/contracts';

export type SourceSystem = IngressEvent['source']['system'];

export type SignatureScheme =
  /** `sha256=<hex hmac>` over the raw body, GitHub style. */
  | { kind: 'hmac_sha256_hex'; header: string; prefix: string }
  /**
   * Slack style: the signature covers `v0:<timestamp>:<body>`, so the timestamp is inside
   * the signed material. That is strictly stronger — an attacker cannot replay a capture
   * under a fresh timestamp, because changing it invalidates the signature.
   */
  | { kind: 'hmac_sha256_versioned'; header: string; prefix: string; timestampHeader: string }
  /** No signature is acceptable. Only ever correct for a source inside the trust boundary. */
  | { kind: 'none' };

export interface SourceRule {
  system: SourceSystem;
  signature: SignatureScheme;
  /** Header carrying the vendor's own event id. Part of the dedupe key. */
  eventIdHeader: string;
  /** Header carrying the source's send time, for the replay window. */
  timestampHeader: string | null;
  /** Header naming the principal the signature proves. Not who typed the text. */
  principalHeader: string | null;
  kindHeader: string;
  subjectTypeHeader: string;
  subjectIdHeader: string;
  subjectVersionHeader: string;
  /**
   * Payload paths whose content is attacker-controlled.
   *
   * `IngressEvent.untrusted_fields` is documented as "never empty by accident". These lists
   * are what makes that true on purpose: a source whose payload carries human prose declares
   * the paths here, and {@link sourceRule} refuses to build a rule for an external source
   * that declares none.
   */
  untrustedFields: readonly string[];
  /** Schema majors this build normalises. Anything else fails closed. */
  supportedMajors: readonly number[];
  defaultSubjectType: EventSubject['type'];
}

/** Sources outside the trust boundary. Their payloads always contain untrusted prose. */
const EXTERNAL: readonly SourceSystem[] = ['github', 'jira', 'slack', 'calendar'];

const RULES: Readonly<Record<SourceSystem, SourceRule>> = {
  github: {
    system: 'github',
    signature: { kind: 'hmac_sha256_hex', header: 'x-hub-signature-256', prefix: 'sha256=' },
    eventIdHeader: 'x-github-delivery',
    timestampHeader: 'x-github-timestamp',
    principalHeader: 'x-github-hook-installation-target-id',
    kindHeader: 'x-kind',
    subjectTypeHeader: 'x-subject-type',
    subjectIdHeader: 'x-subject',
    subjectVersionHeader: 'x-subject-version',
    untrustedFields: ['title', 'body', 'comment.body', 'head_commit.message', 'pull_request.body'],
    supportedMajors: [2],
    defaultSubjectType: 'pull_request',
  },
  jira: {
    system: 'jira',
    signature: { kind: 'hmac_sha256_hex', header: 'x-signature', prefix: '' },
    eventIdHeader: 'x-event-id',
    timestampHeader: 'x-timestamp',
    principalHeader: 'x-principal',
    kindHeader: 'x-kind',
    subjectTypeHeader: 'x-subject-type',
    subjectIdHeader: 'x-subject',
    subjectVersionHeader: 'x-subject-version',
    untrustedFields: ['fields.summary', 'fields.description', 'comment.body'],
    supportedMajors: [2],
    defaultSubjectType: 'ticket',
  },
  slack: {
    system: 'slack',
    signature: {
      kind: 'hmac_sha256_versioned',
      header: 'x-slack-signature',
      prefix: 'v0=',
      timestampHeader: 'x-slack-request-timestamp',
    },
    eventIdHeader: 'x-slack-event-id',
    timestampHeader: 'x-slack-request-timestamp',
    principalHeader: 'x-slack-team-id',
    kindHeader: 'x-kind',
    subjectTypeHeader: 'x-subject-type',
    subjectIdHeader: 'x-subject',
    subjectVersionHeader: 'x-subject-version',
    untrustedFields: ['text', 'blocks'],
    supportedMajors: [2],
    defaultSubjectType: 'message',
  },
  calendar: {
    system: 'calendar',
    signature: { kind: 'hmac_sha256_hex', header: 'x-signature', prefix: '' },
    eventIdHeader: 'x-event-id',
    timestampHeader: 'x-timestamp',
    principalHeader: 'x-principal',
    kindHeader: 'x-kind',
    subjectTypeHeader: 'x-subject-type',
    subjectIdHeader: 'x-subject',
    subjectVersionHeader: 'x-subject-version',
    untrustedFields: ['summary', 'description', 'attendees'],
    supportedMajors: [2],
    defaultSubjectType: 'meeting',
  },
  ci: {
    system: 'ci',
    signature: { kind: 'hmac_sha256_hex', header: 'x-signature', prefix: '' },
    eventIdHeader: 'x-event-id',
    timestampHeader: 'x-timestamp',
    principalHeader: 'x-principal',
    kindHeader: 'x-kind',
    subjectTypeHeader: 'x-subject-type',
    subjectIdHeader: 'x-subject',
    subjectVersionHeader: 'x-subject-version',
    // A CI system reports its own machine-generated results. Its logs are untrusted output,
    // but they travel as artifacts, not in this payload.
    untrustedFields: [],
    supportedMajors: [2],
    defaultSubjectType: 'run',
  },
  operator: {
    system: 'operator',
    signature: { kind: 'hmac_sha256_hex', header: 'x-signature', prefix: '' },
    eventIdHeader: 'x-event-id',
    timestampHeader: 'x-timestamp',
    principalHeader: 'x-principal',
    kindHeader: 'x-kind',
    subjectTypeHeader: 'x-subject-type',
    subjectIdHeader: 'x-subject',
    subjectVersionHeader: 'x-subject-version',
    // Typed by a human, so it is prose, so it is untrusted — an authenticated operator is
    // still a person who can paste an attacker's text into a field.
    untrustedFields: ['reason', 'note'],
    supportedMajors: [2],
    defaultSubjectType: 'ticket',
  },
  internal: {
    system: 'internal',
    signature: { kind: 'none' },
    eventIdHeader: 'x-event-id',
    timestampHeader: null,
    principalHeader: 'x-principal',
    kindHeader: 'x-kind',
    subjectTypeHeader: 'x-subject-type',
    subjectIdHeader: 'x-subject',
    subjectVersionHeader: 'x-subject-version',
    untrustedFields: [],
    supportedMajors: [2],
    defaultSubjectType: 'run',
  },
};

export function sourceRule(system: SourceSystem): SourceRule {
  const rule = RULES[system];
  // Belt and braces on the property that matters most: an external source that declared no
  // untrusted fields would produce events every downstream consumer treats as safe prose.
  if (EXTERNAL.includes(system) && rule.untrustedFields.length === 0) {
    throw new Error(`source rule for "${system}" declares no untrusted fields; external prose must be labelled`);
  }
  return rule;
}

export function isExternalSource(system: SourceSystem): boolean {
  return EXTERNAL.includes(system);
}

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' | 'no_secret' };

/**
 * Verify a delivery's signature over the **raw body bytes**.
 *
 * Over the bytes, never over re-serialised JSON: `JSON.parse` then `JSON.stringify` changes
 * key order and whitespace, so a signature checked against the round-trip would fail for
 * honest payloads and — worse — could be made to pass for dishonest ones where the parser
 * and the verifier disagree about duplicate keys.
 */
export function verifySignature(
  rule: SourceRule,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
  secret: string | null,
): SignatureVerdict {
  const scheme = rule.signature;
  if (scheme.kind === 'none') return { ok: true };

  const presented = header(headers, scheme.header);
  if (presented === undefined) return { ok: false, reason: 'missing' };
  if (secret === null || secret === '') return { ok: false, reason: 'no_secret' };
  if (!presented.startsWith(scheme.prefix)) return { ok: false, reason: 'malformed' };

  const hex = presented.slice(scheme.prefix.length);
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length !== 64) return { ok: false, reason: 'malformed' };

  const material =
    scheme.kind === 'hmac_sha256_versioned'
      ? versionedMaterial(headers, scheme.timestampHeader, body)
      : Buffer.from(body);
  if (material === null) return { ok: false, reason: 'malformed' };

  const expected = createHmac('sha256', secret).update(material).digest();
  const actual = Buffer.from(hex.toLowerCase(), 'hex');
  // Constant time: a byte-by-byte comparison leaks the correct prefix, which is enough to
  // forge a signature one byte at a time.
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}

function versionedMaterial(
  headers: Readonly<Record<string, string>>,
  timestampHeader: string,
  body: Uint8Array,
): Buffer | null {
  const timestamp = header(headers, timestampHeader);
  if (timestamp === undefined) return null;
  return Buffer.concat([Buffer.from(`v0:${timestamp}:`, 'utf8'), Buffer.from(body)]);
}

/** HTTP header names are case-insensitive; a map keyed by the sender's casing is a bug. */
export function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}
