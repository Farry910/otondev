import type { DataClass, MemoryRecord, MemoryRetrieval, MemoryStatus } from '@otondev/contracts';
import type { ServiceClient } from '../hooks.js';

/**
 * Data-plane client interfaces, S13-S14.
 *
 * The split is deliberate and it is what takes the Ditto spike off the critical path
 * (implementation-plan §5 S13): the Memory Service is written against {@link MemoryStore},
 * a SQLite reference implementation satisfies it today, and the Ditto adapter is a second
 * implementation of the *same* interface that passes the *same* conformance suite. If the
 * spike fails, S13 is unaffected.
 */

// ----------------------------------------------------------------------------- S13 Memory

export interface MemoryCandidate {
  tenant_id: string;
  owner_scope: MemoryRecord['owner_scope'];
  record_type: MemoryRecord['record_type'];
  claim: string;
  scope: Record<string, string>;
  provenance: MemoryRecord['provenance'];
  data_class: DataClass;
  acl: MemoryRecord['acl'];
  observed_at: string;
  /**
   * True when the claim's text came from a ticket, transcript, tool output or model — that
   * is, nearly always. The ingestion pipeline quarantines instruction-shaped content from
   * these sources rather than storing it (S13 exit criterion).
   */
  from_untrusted_source: boolean;
}

export type IngestResult =
  | { status: 'stored'; record: MemoryRecord }
  | { status: 'quarantined'; reason: string }
  /** No usable provenance. A claim with no source cannot gain authority by being repeated. */
  | { status: 'rejected'; reason: string };

export interface MemoryQuery {
  tenant_id: string;
  agent_id: string;
  /** ACL groups the caller may read as. The filter runs *before* retrieval, not after. */
  read_as: readonly string[];
  scope: Record<string, string>;
  text: string;
  limit: number;
}

export interface WarmSet {
  records: MemoryRecord[];
  built_at: string;
  /** A warm set past its expiry is stale, and stale is reported rather than served. */
  expires_at: string;
}

export interface MemoryClient extends ServiceClient {
  ingest(candidate: MemoryCandidate): Promise<IngestResult>;
  /**
   * Returns contradictions as contradictions, with dates and status, rather than picking a
   * winner (S13 exit criterion). Citations are mandatory.
   */
  retrieve(query: MemoryQuery): Promise<MemoryRetrieval>;
  supersede(memoryId: string, replacement: MemoryCandidate): Promise<MemoryRecord>;
  /**
   * Propagates through records, embeddings, summaries, warm sets and indexes. A tombstone
   * that only marks the row leaves the claim alive in four other places.
   */
  tombstone(memoryId: string, reason: string): Promise<void>;
  warmSet(agentId: string, scope: Record<string, string>): Promise<WarmSet>;
}

// -------------------------------------------------------------- S14 Storage (S13 and S14)

export interface MemoryStoreFilter {
  tenant_id: string;
  owner_scope?: MemoryRecord['owner_scope'];
  status?: MemoryStatus;
  scope?: Record<string, string>;
  limit?: number;
}

export interface MemoryStoreSubscription {
  close(): void;
}

/**
 * The storage seam. Two implementations must pass one conformance suite: the SQLite
 * reference in S13 and the Ditto adapter in S14.
 *
 * Note what is *not* here. Ditto "is never used for work claims, approval uniqueness,
 * fencing, or revocation" (implementation-plan §5 S14), so this interface offers no
 * compare-and-set, no lease and no uniqueness guarantee. An eventually-consistent replicated
 * store cannot provide them, and an interface that pretended otherwise would let a caller
 * build a work claim on top of it and discover the problem in production.
 */
export interface MemoryStore {
  put(record: MemoryRecord): Promise<void>;
  get(tenantId: string, memoryId: string): Promise<MemoryRecord | null>;
  query(filter: MemoryStoreFilter): Promise<MemoryRecord[]>;
  tombstone(tenantId: string, memoryId: string): Promise<void>;
  /** Partial subscription: a peer receives only the collections its scope covers. */
  subscribe(filter: MemoryStoreFilter, onChange: (record: MemoryRecord) => void): MemoryStoreSubscription;
}

export interface MemoryStoreClient extends ServiceClient, MemoryStore {}
