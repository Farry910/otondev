import type { CognitionRequest, DataClass } from '@otondev/contracts';
import type { BuiltContext } from './context-builder.js';
import type { SecretKind } from './secrets.js';

/**
 * The privacy-aware audit record — cognition-router.md "Audit and privacy".
 *
 * The doc lists the default fields and then says: *"Full prompt/response retention is opt-in
 * by data policy, encrypted, access controlled, and short-lived."* So the default record here
 * has **nowhere to put a prompt**. Not an empty field, not an optional one — the type has no
 * member for it, and {@link CognitionAuditRecord} is what the gateway emits unconditionally.
 *
 * That shape is deliberate. An optional `prompt?: string` is a field someone eventually fills
 * in "just for debugging", and the retention promise quietly stops being true. Opt-in payload
 * capture is therefore a *separate* record type ({@link CognitionPayloadRecord}) that a caller
 * has to construct on purpose, carrying its own expiry.
 *
 * What survives instead is the context digest, which is enough to prove which context produced
 * which answer without keeping the context.
 */

export interface CognitionAuditRecord {
  readonly request_id: string;
  readonly workflow_id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly purpose: CognitionRequest['purpose'];
  readonly risk: CognitionRequest['risk'];

  readonly provider: string;
  readonly model: string;
  readonly model_version: string;
  readonly prompt_template_version: string;
  readonly prompt_template_digest: string;

  readonly data_classes: readonly DataClass[];
  /** Which sections were assembled, and how large — never their content. */
  readonly context_sections: ReadonlyArray<{ name: string; chars: number }>;
  readonly authorized_context_digest: string;
  /** Kinds only. A count and a kind is a DLP verdict; the matched text would be a re-leak. */
  readonly dlp_verdict: {
    readonly findings: number;
    readonly kinds: readonly SecretKind[];
    readonly action: 'none' | 'redacted' | 'refused';
  };
  readonly untrusted_sources: readonly string[];

  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cost_usd: number;
    readonly latency_ms: number;
  };
  readonly retry_count: number;
  readonly fallback_from: string | null;
  readonly schema_verdict: 'valid' | 'invalid' | 'not_applicable';
  readonly completion_reason: string;
  readonly observed_at: string;
}

/**
 * Opt-in payload capture. Constructed only when data policy says so.
 *
 * Separate from the default record so that turning it on is a visible act with an expiry
 * attached, rather than a field that drifts into always being populated.
 */
export interface CognitionPayloadRecord {
  readonly request_id: string;
  readonly prompt: string;
  readonly response: unknown;
  /** Short-lived by contract. The caller sets it; there is no "never expires" value. */
  readonly expires_at: string;
  readonly authorized_by: string;
}

export interface AuditSink {
  record(entry: CognitionAuditRecord): Promise<void>;
  /** Only ever called when policy explicitly permits payload retention. */
  recordPayload?(entry: CognitionPayloadRecord): Promise<void>;
}

/** Collects records in memory. The offline default, and what the tests assert against. */
export class InMemoryAuditSink implements AuditSink {
  readonly entries: CognitionAuditRecord[] = [];
  readonly payloads: CognitionPayloadRecord[] = [];

  async record(entry: CognitionAuditRecord): Promise<void> {
    this.entries.push(entry);
  }

  async recordPayload(entry: CognitionPayloadRecord): Promise<void> {
    this.payloads.push(entry);
  }
}

/**
 * Field names that must never appear in a default audit record, asserted in a test.
 *
 * Same reasoning as `FORBIDDEN_COGNITION_RESULT_FIELDS` in the contracts package: the pressure
 * to "just log the prompt while we debug this" arrives eventually, and it should arrive as a
 * failing test rather than as a quiet commit.
 */
export const FORBIDDEN_AUDIT_FIELDS = [
  'prompt',
  'response',
  'content',
  'context',
  'context_text',
  'messages',
  'completion',
] as const;

export function summariseContextForAudit(
  context: BuiltContext,
): Pick<CognitionAuditRecord, 'context_sections' | 'authorized_context_digest' | 'untrusted_sources' | 'dlp_verdict'> {
  return {
    context_sections: context.sections.map((section) => ({ name: section.name, chars: section.chars })),
    authorized_context_digest: context.digest,
    untrusted_sources: context.untrustedSources,
    dlp_verdict: {
      findings: context.secretFindings.length,
      kinds: [...new Set(context.secretFindings.map((finding) => finding.kind))],
      action: context.secretFindings.length === 0 ? 'none' : 'redacted',
    },
  };
}
