import { z } from 'zod';

/**
 * Identifiers (contracts §1).
 *
 *   "IDs are opaque and unique; display names are never identifiers."
 *   "id: globally_unique_time_orderable_id"
 *
 * Every minted ID is `<prefix><ULID>`: a 48-bit millisecond timestamp followed by 80 bits of
 * randomness, Crockford base32. Time-orderable satisfies the envelope rule; the random tail
 * keeps it unguessable, which matters because capability and approval IDs are quoted in
 * authorization checks.
 *
 * The prefix is part of the identifier, not decoration. A function that takes a `WorkflowId`
 * and is handed a `cap_` rejects it at the boundary instead of three layers in.
 */

export const ID_PREFIX = {
  tenant: 'ten_',
  agent: 'agt_',
  user: 'usr_',
  workflow: 'wf_',
  event: 'evt_',
  correlation: 'cor_',
  plan: 'plan_',
  policyDecision: 'pdec_',
  approval: 'apr_',
  decisionRequest: 'drq_',
  capability: 'cap_',
  action: 'act_',
  memory: 'mem_',
  evidence: 'evb_',
  artifact: 'art_',
  checkpoint: 'chk_',
  cognitionRequest: 'crq_',
  context: 'ctx_',
  workspace: 'wsp_',
  workload: 'wl_',
  meeting: 'mtg_',
  audit: 'aud_',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

/** Crockford base32 — no I, L, O or U, so a transcribed ID cannot be misread. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_BODY = '[0-9A-HJKMNP-TV-Z]{26}';
const ULID_RE = new RegExp(`^${ULID_BODY}$`);

export function idSchema(kind: IdKind) {
  const prefix = ID_PREFIX[kind];
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}${ULID_BODY}$`),
      `expected a ${kind} id of the form ${prefix}<26-char ULID>`,
    );
}

export const TenantId = idSchema('tenant');
export const AgentId = idSchema('agent');
export const UserId = idSchema('user');
export const WorkflowId = idSchema('workflow');
export const EventId = idSchema('event');
export const CorrelationId = idSchema('correlation');
export const PlanId = idSchema('plan');
export const PolicyDecisionId = idSchema('policyDecision');
export const ApprovalId = idSchema('approval');
export const DecisionRequestId = idSchema('decisionRequest');
export const CapabilityId = idSchema('capability');
export const ActionId = idSchema('action');
export const MemoryId = idSchema('memory');
export const EvidenceBundleId = idSchema('evidence');
export const ArtifactId = idSchema('artifact');
export const CheckpointId = idSchema('checkpoint');
export const CognitionRequestId = idSchema('cognitionRequest');
export const ContextId = idSchema('context');
export const WorkspaceId = idSchema('workspace');
export const WorkloadId = idSchema('workload');
export const MeetingId = idSchema('meeting');

/**
 * A reference to something outside the platform: `ticket:jira:ENG-42`,
 * `repo:team/api:branch:agent/ENG-42`, `run:ci:991`. Contracts §3 and §9 use these
 * alongside minted IDs, so they are a first-class shape rather than a loose string.
 */
export const ResourceRef = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[a-z][a-z0-9_]*:[^\s]+$/, 'expected a `<type>:<...>` resource reference');

/** Either a minted ID or an external resource reference. */
export const AnyRef = z.union([z.string().regex(/^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/), ResourceRef]);

/** A content digest. Never a secret; always safe to log. */
export const Sha256Digest = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected `sha256:<64 lowercase hex chars>`');

/** A bare git object id, SHA-1 or SHA-256. */
export const GitSha = z
  .string()
  .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'expected a 40- or 64-character git object id');

/**
 * A human-authored, content-pinned version reference: `engineering-pilot-v2@sha256:...`,
 * `verifier-v3`. Contracts §12 requires policy, prompt, model route, worker image, verifier,
 * persona and memory derivation to be independently versioned and carried in evidence.
 *
 * Deliberately not a minted ID. These are named by people, reviewed by people, and pinned by
 * content — a ULID would make them unreadable in exactly the artifacts humans read.
 */
export const PinnedVersionRef = z
  .string()
  .min(3)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*(@sha256:[0-9a-f]{64})?$/, 'expected `name[@sha256:<digest>]`');

/**
 * A definition of done: `dod_repo_api_v3` (contracts §3, §4).
 *
 * Also not a minted ID, for the same reason. It names a reviewed standard that outlives any
 * one workflow, and both the plan and the workflow record point at it by name.
 */
export const DefinitionOfDoneRef = z
  .string()
  .regex(/^dod_[a-z0-9][a-z0-9_]{0,120}$/, 'expected `dod_<name>`');

function encodeCrockford(value: bigint, length: number): string {
  let out = '';
  let n = value;
  for (let i = 0; i < length; i += 1) {
    out = CROCKFORD[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/**
 * Pure ULID construction. Time and randomness are arguments, never ambient, so the same
 * function backs the production generator and the testkit's deterministic one — there is no
 * second implementation to drift.
 *
 * @param epochMs   milliseconds since the Unix epoch (48 bits)
 * @param randomness exactly 10 bytes (80 bits)
 */
export function ulid(epochMs: number, randomness: Uint8Array): string {
  if (!Number.isInteger(epochMs) || epochMs < 0 || epochMs > 0xffffffffffff) {
    throw new RangeError(`ulid: epochMs ${epochMs} does not fit in 48 bits`);
  }
  if (randomness.length !== 10) {
    throw new RangeError(`ulid: expected 10 bytes of randomness, got ${randomness.length}`);
  }
  let random = 0n;
  for (const byte of randomness) random = (random << 8n) | BigInt(byte);
  return encodeCrockford(BigInt(epochMs), 10) + encodeCrockford(random, 16);
}

export function isUlid(value: string): boolean {
  return ULID_RE.test(value);
}

/** Mints identifiers. Implemented by the SDK for production and by the testkit for tests. */
export interface IdFactory {
  next(kind: IdKind): string;
}
