/**
 * Every statement the Postgres store issues, in one place.
 *
 * Extracted from the store so that the live-Postgres verifier
 * (`scripts/verify-postgres.ts`) executes *these exact strings* rather than a copy someone
 * kept in step by hand. A verifier that runs its own SQL proves the database accepts that
 * SQL, which is not the same claim and is the one that quietly stops being true.
 *
 * `$n` placeholders throughout: the values are workflow ids, tenant ids and JSON documents,
 * several of which come from external systems, and none of them are ever concatenated in.
 */
export const SQL = {
  insert: `INSERT INTO workflow.records (id, tenant_id, record) VALUES ($1, $2, $3::jsonb)`,

  selectRecord: `SELECT record, fencing_token_seq FROM workflow.records WHERE id = $1`,

  /** The row lock that makes the mutator's view authoritative. */
  selectForUpdate: `SELECT record, fencing_token_seq FROM workflow.records WHERE id = $1 FOR UPDATE`,

  /**
   * The compare-and-set. The predicate is on the UPDATE and not only in application code:
   * a store used without a surrounding transaction still must not let two claimants both win.
   */
  updateGuarded: `UPDATE workflow.records
            SET record = $3::jsonb, updated_at = now()
          WHERE id = $1 AND (record ->> 'state_version')::bigint = $2
          RETURNING id`,

  /** GREATEST, so a released lease can never walk the fencing sequence backwards. */
  updateLease: `UPDATE workflow.records
            SET record = $2::jsonb,
                fencing_token_seq = GREATEST(fencing_token_seq, $3),
                updated_at = now()
          WHERE id = $1`,

  insertTransition: `INSERT INTO workflow.transitions
         (id, workflow_id, state_version, accepted, occurred_at, transition)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)`,

  selectTransitions: `SELECT transition FROM workflow.transitions WHERE workflow_id = $1 ORDER BY occurred_at, id`,

  /** Terminal states are excluded in SQL so the index can be partial on the same predicate. */
  selectDue: `SELECT id FROM workflow.records
        WHERE state NOT IN ('DONE', 'REJECTED', 'DENIED', 'CANCELLED', 'FAILED')
          AND (lease_expires_at <= $1::timestamptz OR next_wakeup_at <= $1::timestamptz)
        ORDER BY id`,

  selectActive: `SELECT id FROM workflow.records
        WHERE state NOT IN ('DONE', 'REJECTED', 'DENIED', 'CANCELLED', 'FAILED')
        ORDER BY id`,
} as const;
