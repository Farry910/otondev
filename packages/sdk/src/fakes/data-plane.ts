import type { MemoryRecord, MemoryRetrieval } from '@otondev/contracts';
import { FakeServiceBase } from './base.js';
import type { FakeDefaults } from './base.js';
import type { RuntimeContext } from '../runtime.js';
import type {
  IngestResult,
  MemoryCandidate,
  MemoryClient,
  MemoryQuery,
  MemoryStore,
  MemoryStoreClient,
  MemoryStoreFilter,
  MemoryStoreSubscription,
  WarmSet,
} from '../services/data-plane.js';
import { digestOf, envelopeFor, hexDigestOf, plusSeconds } from './support.js';

/** Minimal in-memory fakes, S13-S14. */

/**
 * Instruction-shaped content from an untrusted source.
 *
 * Deliberately crude — a real detector is S13's job and a hard problem. What matters here is
 * that the fake *has* a quarantine path at all, so a downstream session writing "poison in a
 * ticket description is quarantined" gets a fake that can actually quarantine and does not
 * silently store the poison and pass.
 */
const INSTRUCTION_SHAPED = [
  /\bignore (all|any|the) (previous|prior|above)\b/i,
  /\bdisregard\b.*\binstructions?\b/i,
  /\byou are now\b/i,
  /\bsystem prompt\b/i,
  /\bexfiltrat/i,
];

export function looksLikeInjection(text: string): boolean {
  return INSTRUCTION_SHAPED.some((pattern) => pattern.test(text));
}

// ------------------------------------------------------------------------------- S14

export class FakeMemoryStore extends FakeServiceBase implements MemoryStoreClient {
  readonly serviceId = 'memory-store' as const;
  readonly #records = new Map<string, MemoryRecord>();
  readonly #watchers = new Set<{ filter: MemoryStoreFilter; onChange: (record: MemoryRecord) => void }>();

  async put(record: MemoryRecord): Promise<void> {
    this.#records.set(`${record.tenant_id}:${record.id}`, record);
    for (const watcher of this.#watchers) {
      if (this.#matches(record, watcher.filter)) watcher.onChange(record);
    }
  }

  async get(tenantId: string, memoryId: string): Promise<MemoryRecord | null> {
    return this.#records.get(`${tenantId}:${memoryId}`) ?? null;
  }

  async query(filter: MemoryStoreFilter): Promise<MemoryRecord[]> {
    const hits = [...this.#records.values()].filter((record) => this.#matches(record, filter));
    return filter.limit === undefined ? hits : hits.slice(0, filter.limit);
  }

  async tombstone(tenantId: string, memoryId: string): Promise<void> {
    const key = `${tenantId}:${memoryId}`;
    const record = this.#records.get(key);
    if (record === undefined) return;
    const tombstoned: MemoryRecord = { ...record, status: 'tombstoned' };
    this.#records.set(key, tombstoned);
    for (const watcher of this.#watchers) {
      if (this.#matches(tombstoned, watcher.filter)) watcher.onChange(tombstoned);
    }
  }

  subscribe(filter: MemoryStoreFilter, onChange: (record: MemoryRecord) => void): MemoryStoreSubscription {
    const watcher = { filter, onChange };
    this.#watchers.add(watcher);
    return { close: () => this.#watchers.delete(watcher) };
  }

  #matches(record: MemoryRecord, filter: MemoryStoreFilter): boolean {
    if (record.tenant_id !== filter.tenant_id) return false;
    if (filter.status !== undefined && record.status !== filter.status) return false;
    if (filter.owner_scope !== undefined) {
      if (record.owner_scope.type !== filter.owner_scope.type) return false;
      if (record.owner_scope.id !== filter.owner_scope.id) return false;
    }
    if (filter.scope !== undefined) {
      for (const [key, value] of Object.entries(filter.scope)) {
        if (record.scope[key] !== value) return false;
      }
    }
    return true;
  }
}

// ------------------------------------------------------------------------------- S13

export class FakeMemory extends FakeServiceBase implements MemoryClient {
  readonly serviceId = 'memory' as const;
  readonly #store: MemoryStore;
  readonly #warmTtlSeconds: number;

  constructor(
    runtime: RuntimeContext,
    defaults: FakeDefaults,
    deps: { store: MemoryStore; warmTtlSeconds?: number },
  ) {
    super(runtime, defaults);
    this.#store = deps.store;
    this.#warmTtlSeconds = deps.warmTtlSeconds ?? 900;
  }

  async ingest(candidate: MemoryCandidate): Promise<IngestResult> {
    this.assertNotDenied();

    // No usable provenance, no record. A claim with no source cannot gain authority by being
    // repeated (contracts §9), so the pipeline refuses rather than storing it at low confidence.
    if (candidate.provenance.source_refs.length === 0) {
      return { status: 'rejected', reason: 'no provenance' };
    }
    if (candidate.from_untrusted_source && looksLikeInjection(candidate.claim)) {
      return { status: 'quarantined', reason: 'instruction-shaped content from an untrusted source' };
    }

    const id = this.id('memory');
    const record: MemoryRecord = {
      ...envelopeFor(this.runtime, 'agentdev.memory.v2', id, candidate.tenant_id, 'memory', {
        dataClasses: [candidate.data_class],
      }),
      owner_scope: candidate.owner_scope,
      record_type: candidate.record_type,
      source_or_derived: candidate.provenance.derivation === null ? 'source' : 'derived',
      claim: candidate.claim,
      scope: candidate.scope,
      provenance: candidate.provenance,
      confidence: 0.5,
      status: 'active',
      observed_at: candidate.observed_at,
      valid_from: candidate.observed_at,
      valid_until: null,
      data_class: candidate.data_class,
      acl: candidate.acl,
      retention: { expires_at: null, legal_hold: false },
      supersedes: null,
      integrity: { alg: 'sha256', digest: hexDigestOf(candidate.claim), version: 1 },
    };
    await this.#store.put(record);
    return { status: 'stored', record };
  }

  async retrieve(query: MemoryQuery): Promise<MemoryRetrieval> {
    // Policy filter first: an ACL applied after retrieval has already leaked the count, the
    // timing and often the content (S13: "policy-filter-first retrieval").
    const all = await this.#store.query({ tenant_id: query.tenant_id, scope: query.scope });
    const readable = all.filter((record) => this.#readable(record, query.read_as));
    const active = readable.filter((record) => record.status !== 'tombstoned');
    const matching = active
      .filter((record) => query.text === '' || record.claim.toLowerCase().includes(query.text.toLowerCase()))
      .slice(0, query.limit);

    return {
      query_digest: digestOf(`${query.tenant_id}:${query.text}:${JSON.stringify(query.scope)}`),
      records: matching,
      // Contradictions are returned as contradictions, not resolved in favour of whichever
      // record was written last (S13 exit criterion).
      contradictions: groupContradictions(matching),
      filtered_count: all.length - readable.length,
      retrieved_at: this.runtime.clock.nowIso(),
    };
  }

  async supersede(memoryId: string, replacement: MemoryCandidate): Promise<MemoryRecord> {
    const original = await this.#store.get(replacement.tenant_id, memoryId);
    if (original === null) this.fail('INTERNAL', { reason: 'unknown memory record' });
    const result = await this.ingest(replacement);
    if (result.status !== 'stored') this.fail('MEMORY_QUARANTINED', { reason: result.reason });
    const superseding: MemoryRecord = { ...result.record, supersedes: memoryId };
    await this.#store.put(superseding);
    await this.#store.put({ ...original, status: 'superseded' });
    return superseding;
  }

  async tombstone(memoryId: string, _reason: string): Promise<void> {
    // In a real implementation this traverses records, embeddings, summaries, warm sets and
    // indexes. The fake has only the store — but it must not report success for the others.
    await this.#store.tombstone(this.defaults.tenantId, memoryId);
  }

  async warmSet(agentId: string, scope: Record<string, string>): Promise<WarmSet> {
    const records = await this.#store.query({
      tenant_id: this.defaults.tenantId,
      owner_scope: { type: 'agent', id: agentId },
      status: 'active',
      scope,
    });
    return {
      records,
      built_at: this.runtime.clock.nowIso(),
      // A warm set past its expiry is stale, and stale is reported rather than served
      // (S15 depends on this: "a stale warm-up bundle is refreshed or declared stale").
      expires_at: plusSeconds(this.runtime.clock, this.#warmTtlSeconds),
    };
  }

  #readable(record: MemoryRecord, readAs: readonly string[]): boolean {
    if (record.acl.read.length === 0) return true;
    return record.acl.read.some((group) => readAs.includes(group));
  }
}

/** Records making the same-scoped claim with opposing status. Crude, but present. */
function groupContradictions(records: readonly MemoryRecord[]): string[][] {
  const byScope = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const key = `${record.record_type}:${JSON.stringify(record.scope)}`;
    byScope.set(key, [...(byScope.get(key) ?? []), record]);
  }
  return [...byScope.values()]
    .filter((group) => group.length > 1 && new Set(group.map((r) => r.claim)).size > 1)
    .map((group) => group.map((record) => record.id));
}
