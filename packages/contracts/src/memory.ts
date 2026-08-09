import { z } from 'zod';
import { envelopeExtend } from './envelope.js';
import { AgentId, AnyRef, MemoryId } from './ids.js';
import { BoundedText, DataClass, Rfc3339Utc } from './primitives.js';

/**
 * Memory record, contracts §9.
 *
 *   "The context builder treats `claim` as data and uses provenance/status, not repetition
 *    count, for authority."
 *
 * `claim` is a string that came, ultimately, from a ticket, a transcript, or a model. It is
 * never an instruction. The fields that decide whether it is *believed* are `provenance`,
 * `status` and `confidence` — and `status: 'contested'` exists so that a contradiction can be
 * retrieved as a contradiction rather than silently resolved in favour of whichever record
 * was written last.
 */

export const MEMORY_RECORD_TYPES = [
  'fact',
  'preference',
  'decision',
  'procedure',
  'observation',
  'contact',
] as const;
export const MemoryRecordType = z.enum(MEMORY_RECORD_TYPES);
export type MemoryRecordType = z.infer<typeof MemoryRecordType>;

export const MEMORY_STATUSES = ['active', 'contested', 'superseded', 'tombstoned'] as const;
export const MemoryStatus = z.enum(MEMORY_STATUSES);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const MemoryProvenance = z.object({
  /** Where the claim came from. Empty is not a valid provenance — it is a refusal to store. */
  source_refs: z.array(AnyRef).min(1).max(64),
  derivation: z
    .object({
      model: z.string().max(128),
      template: z.string().max(128),
    })
    .nullable(),
});
export type MemoryProvenance = z.infer<typeof MemoryProvenance>;

export const MemoryRecord = envelopeExtend({
  schema: z.literal('agentdev.memory.v2'),
  id: MemoryId,
  owner_scope: z.object({
    type: z.enum(['agent', 'team', 'tenant']),
    id: z.string().min(1).max(128),
  }),
  record_type: MemoryRecordType,
  source_or_derived: z.enum(['source', 'derived']),
  /** Data. Not an instruction, not a policy, not an approval. */
  claim: BoundedText(2000),
  scope: z.record(z.string().max(64), z.string().max(256)),
  provenance: MemoryProvenance,
  confidence: z.number().min(0).max(1),
  status: MemoryStatus,
  observed_at: Rfc3339Utc,
  valid_from: Rfc3339Utc,
  valid_until: Rfc3339Utc.nullable(),
  data_class: DataClass,
  acl: z.object({
    read: z.array(z.string().max(128)).max(64),
    publish: z.array(z.string().max(128)).max(64),
  }),
  retention: z.object({
    expires_at: Rfc3339Utc.nullable(),
    legal_hold: z.boolean(),
  }),
  supersedes: MemoryId.nullable(),
  integrity: z.object({
    alg: z.literal('sha256'),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.number().int().positive(),
  }),
});
export type MemoryRecord = z.infer<typeof MemoryRecord>;

/**
 * A retrieval answer. Citations are mandatory and contradictions are returned as a set.
 *
 * S13's exit criterion is that retrieval "returns contradictions with dates and status
 * rather than picking one", so the shape has no field in which to put a single winner.
 */
export const MemoryRetrieval = z.object({
  query_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  records: z.array(MemoryRecord).max(128),
  /** Groups of records that disagree, by id. Present and empty, never absent. */
  contradictions: z.array(z.array(MemoryId).min(2)).max(32),
  /** Records excluded by the policy filter, counted but not described. */
  filtered_count: z.number().int().nonnegative(),
  retrieved_at: Rfc3339Utc,
});
export type MemoryRetrieval = z.infer<typeof MemoryRetrieval>;

/** Owner scope for the ACL check, resolved from an agent's identity. */
export const MemoryScopeQuery = z.object({
  agent_id: AgentId,
  read_as: z.array(z.string().max(128)).max(64),
});
export type MemoryScopeQuery = z.infer<typeof MemoryScopeQuery>;
