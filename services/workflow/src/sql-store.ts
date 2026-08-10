import type { WorkflowRecord, WorkflowTransition } from '@otondev/contracts';
import { SQL } from './sql-statements.js';
import type { CommitOutcome, LeaseMutator, Mutator, WorkflowStore } from './store.js';

/**
 * The Postgres reference implementation.
 *
 * S2's brief: "the Temporal-vs-Postgres decision stays open until the crash/idempotency spike
 * reports; a Postgres reference implementation is needed regardless."
 *
 * It takes an injected {@link SqlExecutor} rather than a driver. Two reasons, and the second
 * is the real one:
 *
 *  1. `pnpm-lock.yaml` is a Wave-0-owned file (implementation-plan §6 rule 4) and no driver
 *     is in it, so adding `pg` here would be a shared-file edit this package may not make.
 *  2. A store that depends on a connection pool cannot be unit-tested at all, and the thing
 *     most worth testing here is the *shape of the statements* — specifically that the
 *     compare-and-set predicate is present and that the record and its transition are written
 *     in one transaction. Those are checkable against a recording executor; they are the two
 *     properties that make the store correct, and they are exactly what a driver would hide.
 *
 * The statements themselves live in `sql-statements.ts` and are verified against a real
 * postgres:16.4 by `scripts/verify-postgres.ts` — every one of them is PREPAREd against the
 * live schema, and the compare-and-set, fencing sequence and scan predicates are exercised
 * for behaviour. That check earned its place immediately: the first migration used generated
 * columns casting `text::timestamptz`, which is STABLE rather than IMMUTABLE, so PostgreSQL
 * refused the DDL outright. No mocked executor could have found it.
 *
 * Still unproven: this class. The `SqlExecutor` adapter over a real driver does not exist,
 * because no driver is in the frozen root lockfile. The SQL is verified; the plumbing between
 * this class and a connection pool is not.
 */

export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params: readonly unknown[]): Promise<T[]>;
  /**
   * Runs `fn` inside one transaction. Implementations must roll back if it throws — the
   * atomicity of {@link WorkflowStore.commit} rests entirely on that.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

interface RecordRow {
  record: WorkflowRecord | string;
  fencing_token_seq: number | string;
}

function parseRecord(row: RecordRow): WorkflowRecord {
  return typeof row.record === 'string' ? (JSON.parse(row.record) as WorkflowRecord) : row.record;
}

export class SqlWorkflowStore implements WorkflowStore {
  readonly #sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  async insert(record: WorkflowRecord): Promise<void> {
    await this.#sql.query(SQL.insert, [record.id, record.tenant_id, JSON.stringify(record)]);
  }

  async get(workflowId: string): Promise<WorkflowRecord | null> {
    const rows = await this.#sql.query<RecordRow>(SQL.selectRecord, [workflowId]);
    const row = rows[0];
    return row === undefined ? null : parseRecord(row);
  }

  /**
   * `SELECT ... FOR UPDATE` inside the transaction, then a guarded `UPDATE`.
   *
   * The row lock is what makes the mutator's view authoritative; the `state_version` predicate
   * on the UPDATE is belt and braces against a store used without a transaction. Both are
   * cheap, and the failure they prevent — two claimants both believing they won — is the one
   * the whole platform's concurrency model rests on not happening.
   */
  async commit(
    workflowId: string,
    expectedStateVersion: number,
    mutate: Mutator,
  ): Promise<CommitOutcome> {
    return this.#sql.transaction(async (tx) => {
      const rows = await tx.query<RecordRow>(SQL.selectForUpdate, [workflowId]);
      const row = rows[0];
      if (row === undefined) return { status: 'not_found' };

      const current = parseRecord(row);
      if (current.state_version !== expectedStateVersion) {
        return { status: 'version_conflict', actual_state_version: current.state_version };
      }

      const { record, transition } = mutate(current);

      const updated = await tx.query(SQL.updateGuarded, [
        workflowId,
        expectedStateVersion,
        JSON.stringify(record),
      ]);
      if (updated.length === 0) {
        return { status: 'version_conflict', actual_state_version: current.state_version };
      }

      await this.#insertTransition(tx, transition);
      return { status: 'committed', record };
    });
  }

  async mutate(workflowId: string, mutate: LeaseMutator): Promise<WorkflowRecord | null> {
    return this.#sql.transaction(async (tx) => {
      const rows = await tx.query<RecordRow>(SQL.selectForUpdate, [workflowId]);
      const row = rows[0];
      if (row === undefined) return null;

      const current = parseRecord(row);
      const seq = Number(row.fencing_token_seq);
      let issued: number | null = null;

      const next = mutate(current, () => {
        issued = seq + 1;
        return issued;
      });

      await tx.query(SQL.updateLease, [workflowId, JSON.stringify(next), issued ?? seq]);
      return next;
    });
  }

  async appendRefusal(transition: WorkflowTransition): Promise<void> {
    await this.#insertTransition(this.#sql, transition);
  }

  async transitions(workflowId: string): Promise<WorkflowTransition[]> {
    const rows = await this.#sql.query<{ transition: WorkflowTransition | string }>(
      SQL.selectTransitions,
      [workflowId],
    );
    return rows.map((row) =>
      typeof row.transition === 'string'
        ? (JSON.parse(row.transition) as WorkflowTransition)
        : row.transition,
    );
  }

  async due(nowMs: number): Promise<string[]> {
    const now = new Date(nowMs).toISOString();
    const rows = await this.#sql.query<{ id: string }>(SQL.selectDue, [now]);
    return rows.map((row) => row.id);
  }

  async active(): Promise<string[]> {
    const rows = await this.#sql.query<{ id: string }>(SQL.selectActive, []);
    return rows.map((row) => row.id);
  }

  async #insertTransition(sql: SqlExecutor, transition: WorkflowTransition): Promise<void> {
    await sql.query(
      SQL.insertTransition,
      [
        transition.id,
        transition.workflow_id,
        transition.accepted ? transition.state_version : null,
        transition.accepted,
        transition.occurred_at,
        JSON.stringify(transition),
      ],
    );
  }
}
