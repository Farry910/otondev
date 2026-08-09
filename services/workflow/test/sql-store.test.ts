import type { WorkflowRecord } from '@otondev/contracts';
import { FakeClock, deterministicIdFactory } from '@otondev/testkit';
import { describe, expect, it } from 'vitest';
import { MemoryWorkflowStore, SqlWorkflowStore, WorkflowEngine, noContainment } from '../src/index.js';
import type { SqlExecutor } from '../src/index.js';

/**
 * The SQL store cannot be run against a live Postgres here — no driver is in the frozen root
 * lockfile — so what is tested is the property a driver would hide: **the statements are the
 * right shape**.
 *
 * Two things make this store correct, and both are visible in the SQL:
 *
 *   1. the compare-and-set predicate is on the UPDATE, not only in application code;
 *   2. the record and its transition event are written inside one transaction.
 *
 * A recording executor sees both. It cannot tell us Postgres accepts the syntax, and the
 * README says so rather than letting a green test imply otherwise.
 */

interface Recorded {
  sql: string;
  params: readonly unknown[];
  depth: number;
}

function recordingExecutor(rowsFor: (sql: string) => unknown[]) {
  const log: Recorded[] = [];
  let depth = 0;

  const make = (): SqlExecutor => ({
    async query<T>(sql: string, params: readonly unknown[]): Promise<T[]> {
      log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params, depth });
      return rowsFor(sql) as T[];
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      depth += 1;
      try {
        return await fn(make());
      } finally {
        depth -= 1;
      }
    },
  });

  return { executor: make(), log };
}

const clock = new FakeClock('2026-01-01T00:00:00Z');
const ids = deterministicIdFactory({ clock });

async function seedRecord(): Promise<WorkflowRecord> {
  const engine = new WorkflowEngine({
    runtime: { clock, ids },
    store: new MemoryWorkflowStore(),
    containment: noContainment,
  });
  return engine.create({
    tenant_id: ids.next('tenant'),
    agent_id: ids.next('agent'),
    type: 'ticket_delivery',
    goal_ref: `art_${'0'.repeat(26)}`,
    source_refs: ['ticket:jira:ENG-42'],
    definition_of_done_ref: 'dod_default_v1',
    risk: 'low',
    data_classes: ['internal_source'],
    autonomy_required: 'A2',
    priority: 50,
    budget: { usd_max: 5, deadline: '2030-01-01T00:00:00Z', cpu_seconds: 3600 },
  });
}

describe('SqlWorkflowStore statement shape', () => {
  it('locks the row, guards the UPDATE on state_version, and writes both rows in one transaction', async () => {
    const record = await seedRecord();
    const { executor, log } = recordingExecutor((sql) =>
      sql.includes('SELECT record') ? [{ record, fencing_token_seq: 0 }] : [{ id: record.id }],
    );

    const outcome = await new SqlWorkflowStore(executor).commit(record.id, 0, (current) => ({
      record: { ...current, state: 'TRIAGED', state_version: 1 },
      transition: {
        ...current,
        schema: 'agentdev.transition.v2',
        workflow_id: current.id,
        from_state: 'RECEIVED',
        to_state: 'TRIAGED',
        state_version: 1,
        channel: 'normal',
        accepted: true,
        reason_codes: ['OK'],
        fencing_token: null,
        occurred_at: clock.nowIso(),
      } as never,
    }));

    expect(outcome.status).toBe('committed');

    const select = log.find((entry) => entry.sql.startsWith('SELECT record'));
    const update = log.find((entry) => entry.sql.startsWith('UPDATE workflow.records'));
    const insert = log.find((entry) => entry.sql.startsWith('INSERT INTO workflow.transitions'));

    expect(select?.sql).toContain('FOR UPDATE');
    // The predicate, not just an application-level check that a concurrent writer could slip past.
    expect(update?.sql).toContain("(record ->> 'state_version')::bigint = $2");
    expect(update?.params[1]).toBe(0);

    // Every statement inside the transaction callback, so a failure rolls the pair back
    // together. A transition event without its state change is the ambiguity the whole
    // store design exists to prevent.
    expect([select?.depth, update?.depth, insert?.depth]).toEqual([1, 1, 1]);
  });

  it('reports a version conflict without writing anything', async () => {
    const record = await seedRecord();
    const { executor, log } = recordingExecutor(() => [{ record, fencing_token_seq: 0 }]);

    const outcome = await new SqlWorkflowStore(executor).commit(record.id, 99, () => {
      throw new Error('the mutator must not run on a conflict');
    });

    expect(outcome).toEqual({ status: 'version_conflict', actual_state_version: 0 });
    expect(log.filter((entry) => entry.sql.startsWith('UPDATE'))).toHaveLength(0);
    expect(log.filter((entry) => entry.sql.startsWith('INSERT'))).toHaveLength(0);
  });

  it('never lets the fencing sequence move backwards', async () => {
    const record = await seedRecord();
    const { executor, log } = recordingExecutor((sql) =>
      sql.includes('SELECT record') ? [{ record, fencing_token_seq: 7 }] : [],
    );

    await new SqlWorkflowStore(executor).mutate(record.id, (current, nextToken) => ({
      ...current,
      lease: { owner: `wl_${'0'.repeat(26)}`, expires_at: '2030-01-01T00:00:00Z', fencing_token: nextToken() },
    }));

    const update = log.find((entry) => entry.sql.startsWith('UPDATE workflow.records'));
    expect(update?.sql).toContain('GREATEST(fencing_token_seq, $3)');
    expect(update?.params[2]).toBe(8);
  });

  it('the recovery scan excludes terminal states in SQL, not in memory', async () => {
    const { executor, log } = recordingExecutor(() => []);
    await new SqlWorkflowStore(executor).due(Date.parse('2026-01-01T00:00:00Z'));

    const scan = log.at(0)?.sql ?? '';
    expect(scan).toContain("state NOT IN ('DONE', 'REJECTED', 'DENIED', 'CANCELLED', 'FAILED')");
    expect(scan).toContain('lease_expires_at <= $1');
    expect(scan).toContain('next_wakeup_at <= $1');
  });
});
