import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DefinitionOfDoneRef, GitSha, ID_PREFIX, idSchema, isUlid, PinnedVersionRef, ulid } from './ids.js';
import { DataClassSet, minAutonomy, mostRestrictiveDataClass } from './primitives.js';
import { isSecretFieldName, redact, REDACTED, findSecretFields } from './redaction.js';
import { currentSchemaId, negotiate, parseSchemaId, SCHEMA_VERSIONS } from './versioning.js';
import { parseEnvelope, withinSizeBound } from './envelope.js';
import { ERROR_SPECS, ContractError, ErrorContract, makeError } from './errors.js';
import type { ErrorCode } from './errors.js';
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  isTerminal,
  TERMINAL_STATES,
  WORKFLOW_STATES,
} from './workflow-states.js';
import { mayAutoRetry } from './action.js';
import { evidenceGateFailures } from './evidence.js';
import { isAllowedMetricLabel } from './audit.js';
import { FORBIDDEN_COGNITION_RESULT_FIELDS } from './cognition.js';
import { parseAs, parseRecord, REGISTERED_SCHEMA_IDS, SCHEMA_REGISTRY } from './registry.js';
import { emitJsonSchemas, jsonSchemaFor, serialiseSchema } from './json-schema.js';
import { EXAMPLES } from './examples.js';
import { dedupeKey } from './event.js';

describe('identifiers (§1)', () => {
  it('produces time-orderable ULIDs', () => {
    const early = ulid(1_700_000_000_000, new Uint8Array(10).fill(255));
    const late = ulid(1_700_000_000_001, new Uint8Array(10));
    // Lexicographic order must follow time order even when the random tail says otherwise.
    expect(early < late).toBe(true);
    expect(isUlid(early)).toBe(true);
    expect(early).toHaveLength(26);
  });

  it('refuses randomness or a timestamp that does not fit', () => {
    expect(() => ulid(1, new Uint8Array(9))).toThrow(/10 bytes/);
    expect(() => ulid(-1, new Uint8Array(10))).toThrow(/48 bits/);
    expect(() => ulid(2 ** 48, new Uint8Array(10))).toThrow(/48 bits/);
  });

  it('rejects an id carrying the wrong prefix', () => {
    const body = ulid(1_700_000_000_000, new Uint8Array(10));
    expect(idSchema('workflow').safeParse(`${ID_PREFIX.workflow}${body}`).success).toBe(true);
    expect(idSchema('workflow').safeParse(`${ID_PREFIX.capability}${body}`).success).toBe(false);
    expect(idSchema('workflow').safeParse('wf_not-a-ulid').success).toBe(false);
  });

  it('never emits an ambiguous Crockford character', () => {
    const body = ulid(Date.parse('2026-07-30T08:00:03Z'), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(body).not.toMatch(/[ILOU]/);
  });
});

describe('data class and autonomy floors', () => {
  it('takes the most restrictive data class present', () => {
    expect(mostRestrictiveDataClass(['public', 'restricted', 'internal'])).toBe('restricted');
    expect(mostRestrictiveDataClass(['public'])).toBe('public');
  });

  it('takes the minimum autonomy across every dimension (S4)', () => {
    expect(minAutonomy(['A4', 'A1', 'A3'])).toBe('A1');
    expect(minAutonomy(['A2'])).toBe('A2');
  });

  it('refuses an empty set rather than inventing a default', () => {
    expect(() => mostRestrictiveDataClass([])).toThrow();
    expect(() => minAutonomy([])).toThrow();
  });
});

describe('secret-class data is illegal in a contract (§1)', () => {
  it('refuses an envelope that declares the secret class', () => {
    // The class exists so it can be rejected. Without it, "secret values are illegal in
    // contracts" is a sentence in a document rather than a validation failure.
    const record = { ...(EXAMPLES['agentdev.event.v2'] as object), data_classes: ['secret'] };
    const result = parseRecord(record);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('refuses it even alongside a legal class', () => {
    expect(DataClassSet.safeParse(['internal', 'secret']).success).toBe(false);
    expect(DataClassSet.safeParse(['internal', 'restricted']).success).toBe(true);
  });

  it('refuses an empty set', () => {
    expect(DataClassSet.safeParse([]).success).toBe(false);
  });
});

describe('human-named references are not minted ids', () => {
  it('accepts a definition of done named by a person', () => {
    expect(DefinitionOfDoneRef.safeParse('dod_repo_api_v3').success).toBe(true);
    expect(DefinitionOfDoneRef.safeParse('repo_api_v3').success).toBe(false);
  });

  it('accepts a version reference with or without a content pin', () => {
    expect(PinnedVersionRef.safeParse('verifier-v3').success).toBe(true);
    expect(PinnedVersionRef.safeParse(`engineering-pilot-v2@sha256:${'a'.repeat(64)}`).success).toBe(true);
    expect(PinnedVersionRef.safeParse('verifier v3').success).toBe(false);
  });

  it('accepts both git object id widths', () => {
    expect(GitSha.safeParse('a'.repeat(40)).success).toBe(true);
    expect(GitSha.safeParse('a'.repeat(64)).success).toBe(true);
    expect(GitSha.safeParse('a'.repeat(39)).success).toBe(false);
  });
});

describe('version negotiation fails closed (§1, §12)', () => {
  it('accepts a supported major', () => {
    const result = negotiate('agentdev.event.v2');
    expect(result).toMatchObject({ ok: true, type: 'event', major: 2, current: true });
  });

  it('refuses a NEWER major — the dangerous case', () => {
    const result = negotiate('agentdev.event.v3');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('unsupported_major');
  });

  it('refuses an older major outside the supported window', () => {
    const result = negotiate('agentdev.event.v1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('unsupported_major');
  });

  it('refuses a schema type it has never heard of', () => {
    const result = negotiate('agentdev.telepathy.v2');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('unknown_type');
  });

  it('refuses a malformed identifier', () => {
    for (const bad of ['', 'event.v2', 'agentdev.event', 'agentdev.Event.v2', 'agentdev.event.vX']) {
      expect(negotiate(bad).ok, bad).toBe(false);
    }
  });

  it('parses the identifier it accepts', () => {
    expect(parseSchemaId('agentdev.policy_decision.v2')).toEqual({
      raw: 'agentdev.policy_decision.v2',
      type: 'policy_decision',
      major: 2,
    });
  });

  it('advertises only the majors it actually implements', () => {
    // Listing a prior major we have not written a migrator for would promise a
    // compatibility that does not exist — worse than having none.
    for (const [type, policy] of Object.entries(SCHEMA_VERSIONS)) {
      expect(policy.supported, type).toContain(policy.current);
      expect(currentSchemaId(type as keyof typeof SCHEMA_VERSIONS)).toBe(
        `agentdev.${type}.v${policy.current}`,
      );
    }
  });
});

describe('envelope (§1)', () => {
  const valid = EXAMPLES['agentdev.event.v2'] as Record<string, unknown>;

  it('accepts a well-formed envelope', () => {
    expect(parseEnvelope(valid).ok).toBe(true);
  });

  it('requires tenant_id — it is part of every storage key and authorization check', () => {
    const { tenant_id: _dropped, ...without } = valid;
    const result = parseEnvelope(without);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.issues.some((i) => i.path === 'tenant_id')).toBe(true);
  });

  it('requires correlation_id', () => {
    const { correlation_id: _dropped, ...without } = valid;
    expect(parseEnvelope(without).ok).toBe(false);
  });

  it('does not echo the offending value into an issue', () => {
    // Validation failures get logged. The value that failed is exactly the kind of thing
    // that turns out to be a token someone pasted into a ticket.
    const smuggled = 'ghp_thisLooksLikeACredential0000000000';
    const result = parseEnvelope({ ...valid, tenant_id: smuggled });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const rendered = JSON.stringify(result.failure.issues);
      expect(rendered).not.toContain(smuggled);
    }
  });

  it('bounds payload size', () => {
    expect(withinSizeBound({ a: 'x'.repeat(10) })).toBe(true);
    expect(withinSizeBound({ a: 'x'.repeat(300 * 1024) })).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(withinSizeBound(cyclic)).toBe(false);
  });
});

describe('the registry parses every schema (§1-§11)', () => {
  it('has an example for every registered schema, and each one parses', () => {
    for (const id of REGISTERED_SCHEMA_IDS) {
      const example = EXAMPLES[id];
      expect(example, `no example for ${id}`).toBeDefined();
      const result = SCHEMA_REGISTRY[id].safeParse(example);
      expect(
        result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        `${id} example failed its own schema`,
      ).toEqual([]);
    }
  });

  it('routes an untrusted record by its declared schema', () => {
    const parsed = parseRecord(EXAMPLES['agentdev.capability.v2']);
    expect(parsed.ok).toBe(true);
  });

  it('fails closed on an unknown major before reading any field', () => {
    const record = { ...(EXAMPLES['agentdev.event.v2'] as object), schema: 'agentdev.event.v9' };
    const result = parseRecord(record);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('SCHEMA_MAJOR_UNSUPPORTED');
  });

  it('rejects a record whose schema does not match what the caller expected', () => {
    const result = parseAs('agentdev.plan.v2', EXAMPLES['agentdev.event.v2']);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-object', () => {
    for (const bad of [null, 42, 'text', []]) {
      const result = parseRecord(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('ENVELOPE_INVALID');
    }
  });

  it('rejects an oversized record', () => {
    const record = {
      ...(EXAMPLES['agentdev.memory.v2'] as object),
      scope: Object.fromEntries(
        Array.from({ length: 2000 }, (_, i) => [`k${i}`, 'v'.repeat(200)]),
      ),
    };
    const result = parseRecord(record);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('workflow state machine (§3)', () => {
  it('covers every state in the transition table', () => {
    for (const state of WORKFLOW_STATES) {
      expect(ALLOWED_TRANSITIONS[state], state).toBeDefined();
    }
  });

  it('lets nothing leave a terminal state, by any channel', () => {
    for (const from of TERMINAL_STATES) {
      expect(isTerminal(from)).toBe(true);
      for (const to of WORKFLOW_STATES) {
        for (const channel of ['normal', 'operator', 'recovery'] as const) {
          expect(canTransition(from, to, channel), `${from} -> ${to} via ${channel}`).toBe(false);
        }
      }
    }
  });

  it('follows the table on the normal channel', () => {
    expect(canTransition('LEASED', 'EXECUTING')).toBe(true);
    expect(canTransition('EXECUTING', 'DELIVERING')).toBe(false); // must verify first
    expect(canTransition('VERIFYING', 'DELIVERING')).toBe(true);
    expect(canTransition('RECEIVED', 'DONE')).toBe(false);
  });

  it('lets an operator pause or cancel from any non-terminal state', () => {
    for (const from of WORKFLOW_STATES) {
      if (isTerminal(from)) continue;
      expect(canTransition(from, 'PAUSED', 'operator'), from).toBe(true);
      expect(canTransition(from, 'CANCELLED', 'operator'), from).toBe(true);
    }
  });

  it('does not let the ordinary engine pause from anywhere', () => {
    // Only LEASED and EXECUTING may pause normally; PAUSED from RECEIVED must come from an
    // operator, so the channel is recorded on the transition event.
    expect(canTransition('RECEIVED', 'PAUSED', 'normal')).toBe(false);
    expect(canTransition('EXECUTING', 'PAUSED', 'normal')).toBe(true);
  });

  it('lets recovery resume only into a safe active state', () => {
    expect(canTransition('RECOVERING', 'EXECUTING')).toBe(true);
    expect(canTransition('RECOVERING', 'DONE')).toBe(false);
    expect(canTransition('EXECUTING', 'RECOVERING', 'recovery')).toBe(true);
    expect(canTransition('EXECUTING', 'RECOVERING', 'normal')).toBe(false);
  });
});

describe('error contract (§11)', () => {
  it('names the eight codes the document lists', () => {
    for (const code of [
      'POLICY_DENIED',
      'APPROVAL_EXPIRED',
      'LEASE_FENCED',
      'ACTION_OUTCOME_UNKNOWN',
      'DATA_PROVIDER_FORBIDDEN',
      'VERIFY_FAILED',
      'PRESENCE_CONSENT_REQUIRED',
      'MEMORY_PROVENANCE_MISSING',
    ] satisfies ErrorCode[]) {
      expect(ERROR_SPECS[code]).toBeDefined();
    }
  });

  it('gives every code the six required attributes', () => {
    for (const [code, spec] of Object.entries(ERROR_SPECS)) {
      expect(typeof spec.retryable, code).toBe('boolean');
      expect(spec.message.length, code).toBeGreaterThan(0);
      expect(spec.component, code).toBeTruthy();
      expect(spec, code).toHaveProperty('transition');
    }
  });

  it('never lets caller input reach the public message', () => {
    const error = makeError('POLICY_DENIED', {
      diagnostic_ref: 'audit:x#1',
      occurred_at: '2026-07-30T08:00:03Z',
      details: { note: 'provider said: token ghp_leak' },
    });
    expect(error.public_message).toBe(ERROR_SPECS.POLICY_DENIED.message);
    expect(error.public_message).not.toContain('ghp_leak');
    expect(ErrorContract.safeParse(error).success).toBe(true);
  });

  it('redacts a secret-class key out of details', () => {
    const error = makeError('INTERNAL', {
      diagnostic_ref: 'audit:x#2',
      occurred_at: '2026-07-30T08:00:03Z',
      details: { api_key: 'sk-live-abc', attempt: 3 },
    });
    expect(error.details).toEqual({ api_key: REDACTED, attempt: 3 });
  });

  it('carries its contract when thrown', () => {
    const contract = makeError('LEASE_FENCED', {
      diagnostic_ref: 'audit:x#3',
      occurred_at: '2026-07-30T08:00:03Z',
    });
    const thrown = new ContractError(contract);
    expect(thrown.code).toBe('LEASE_FENCED');
    expect(thrown.retryable).toBe(false);
    expect(thrown.contract.recommended_transition).toBe('RECOVERING');
  });

  it('recommends only real workflow states', () => {
    for (const [code, spec] of Object.entries(ERROR_SPECS)) {
      if (spec.transition === null) continue;
      expect(WORKFLOW_STATES, code).toContain(spec.transition);
    }
  });
});

describe('redaction by schema, not by string matching (§1)', () => {
  it('classifies field names', () => {
    for (const secret of ['password', 'api_key', 'apiKey', 'client_secret', 'refresh_token', 'Authorization']) {
      expect(isSecretFieldName(secret), secret).toBe(true);
    }
    for (const safe of [
      'lease_fencing_token', // a counter, published in the capability
      'cancellation_token',
      'input_tokens',
      'broker_signature', // a signature is meant to be public
      'authenticated_principal',
      'authn_strength',
      'tokenizer',
      'author',
    ]) {
      expect(isSecretFieldName(safe), safe).toBe(false);
    }
  });

  it('redacts nested and array-held secrets', () => {
    const redacted = redact({
      outer: { password: 'p', list: [{ token: 't' }, { ok: 1 }] },
      keep: 'value',
    });
    expect(redacted).toEqual({
      outer: { password: REDACTED, list: [{ token: REDACTED }, { ok: 1 }] },
      keep: 'value',
    });
  });

  it('survives a cycle instead of crashing the logger', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node['self'] = node;
    expect(redact(node)).toEqual({ name: 'a', self: '[circular]' });
  });

  it('truncates rather than letting one field fill a log', () => {
    const out = redact({ blob: 'x'.repeat(5000) }, { maxStringLength: 32 }) as { blob: string };
    expect(out.blob.length).toBeLessThan(60);
    expect(out.blob).toContain('[truncated]');
  });

  it('proves NO registered schema has anywhere to put a credential', () => {
    // The structural half of the guarantee. S8's "no secret-class field is persistable by
    // construction" reduces to this being empty.
    const offenders: string[] = [];
    for (const [id, schema] of Object.entries(emitJsonSchemas())) {
      for (const path of findSecretFields(schema)) offenders.push(`${id} ${path}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('cognition returns no authorization (§8)', () => {
  it('has no authorization-shaped field in the result schema', () => {
    const schema = JSON.stringify(jsonSchemaFor('agentdev.cognition_result.v2'));
    const properties = Object.keys(
      (jsonSchemaFor('agentdev.cognition_result.v2')['properties'] ?? {}) as object,
    );
    for (const forbidden of FORBIDDEN_COGNITION_RESULT_FIELDS) {
      expect(properties, forbidden).not.toContain(forbidden);
    }
    expect(schema).toBeTruthy();
  });
});

describe('external action idempotency (§7)', () => {
  it('forbids automatic retry while the outcome is unknown', () => {
    expect(mayAutoRetry('outcome_unknown')).toBe(false);
    expect(mayAutoRetry('sent')).toBe(false);
    expect(mayAutoRetry('succeeded')).toBe(false);
    expect(mayAutoRetry('failed')).toBe(true);
    expect(mayAutoRetry('prepared')).toBe(true);
  });
});

describe('evidence delivery gate (§10)', () => {
  it('passes a complete bundle', () => {
    expect(
      evidenceGateFailures({
        checks: [{ name: 'unit', status: 'pass' }],
        verifier: { verdict: 'pass' },
      }),
    ).toEqual([]);
  });

  it('never reports a skipped check as a pass', () => {
    const failures = evidenceGateFailures({
      checks: [{ name: 'unit', status: 'skipped' }],
      verifier: { verdict: 'inconclusive' },
    });
    expect(failures).toContain('verifier verdict is "inconclusive"');
  });

  it('refuses when the verifier failed even if every check passed', () => {
    expect(
      evidenceGateFailures({
        checks: [{ name: 'unit', status: 'pass' }],
        verifier: { verdict: 'fail' },
      }),
    ).toEqual(['verifier verdict is "fail"']);
  });

  it('requires a reason for a skipped check', () => {
    const bundle = structuredClone(EXAMPLES['agentdev.evidence.v2']) as {
      checks: { status: string; reason: string | null }[];
    };
    const skipped = bundle.checks[1];
    expect(skipped).toBeDefined();
    if (skipped) skipped.reason = null;
    expect(parseRecord(bundle).ok).toBe(false);
  });
});

describe('metric label allow-list (S8)', () => {
  it('permits bounded labels and refuses unbounded ones', () => {
    expect(isAllowedMetricLabel('tenant_id')).toBe(true);
    expect(isAllowedMetricLabel('error_code')).toBe(true);
    for (const unbounded of ['ticket_id', 'prompt', 'filename', 'user_email', 'workflow_id']) {
      expect(isAllowedMetricLabel(unbounded), unbounded).toBe(false);
    }
  });
});

describe('emitted JSON Schema artifacts', () => {
  const schemasDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

  it('exists on disk for every registered schema and is byte-current', () => {
    // The .NET companion, the Windows supervisor and any Python executor consume these
    // files. A stale artifact surfaces as one language rejecting a record the other
    // considers valid — a full day of debugging that looks like a networking problem.
    const emitted = emitJsonSchemas();
    const stale: string[] = [];
    for (const [id, schema] of Object.entries(emitted)) {
      const file = join(schemasDir, `${id}.json`);
      if (!existsSync(file)) {
        stale.push(`missing ${id}.json`);
        continue;
      }
      if (readFileSync(file, 'utf8') !== serialiseSchema(schema)) stale.push(`stale ${id}.json`);
    }
    expect(stale, 'run: pnpm --filter @otondev/contracts run emit').toEqual([]);
  });

  it('leaves no orphan behind when a schema is removed', () => {
    const expected = new Set(REGISTERED_SCHEMA_IDS.map((id) => `${id}.json`));
    const onDisk = readdirSync(schemasDir).filter((f) => f.endsWith('.json'));
    expect(onDisk.filter((f) => !expected.has(f))).toEqual([]);
  });
});

describe('ingress dedupe key (§2)', () => {
  it('has exactly one construction', () => {
    expect(
      dedupeKey({
        tenant_id: 'ten_acme',
        system: 'jira',
        installation_id: 'jira_acme',
        source_event_id: 'vendor_event_123',
      }),
    ).toBe('ten_acme:jira:jira_acme:vendor_event_123');
  });
});
