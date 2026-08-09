-- S2 owns the `workflow` schema. The schema and its role are created by
-- infra/dev/postgres/01-service-schemas.sql; this migration creates the tables inside it and
-- is run as the `otondev_workflow` role, whose search_path is already `workflow`.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS workflow.records (
    id                     text PRIMARY KEY,
    tenant_id              text NOT NULL,
    -- The whole enveloped record. Kept as jsonb rather than shredded into columns because
    -- contracts §12 requires readers to support the current and one prior major version, and
    -- a column-per-field table makes that a migration every time a field is added.
    record                 jsonb NOT NULL,

    -- Projected out of the record because every one of them is either a predicate in the
    -- recovery scan or the target of the compare-and-set. A generated column keeps them
    -- honest: they cannot drift from the record they were projected from.
    state                  text  GENERATED ALWAYS AS (record ->> 'state') STORED,
    state_version          bigint GENERATED ALWAYS AS ((record ->> 'state_version')::bigint) STORED,
    lease_expires_at       timestamptz GENERATED ALWAYS AS ((record #>> '{lease,expires_at}')::timestamptz) STORED,
    next_wakeup_at         timestamptz GENERATED ALWAYS AS ((record ->> 'next_wakeup_at')::timestamptz) STORED,

    -- Monotonic per workflow, and deliberately NOT derived from the record: a released lease
    -- sets `record.lease` to null, and a counter that lived there would restart at 1 and let
    -- a stale worker's token be accepted by the next holder.
    fencing_token_seq      bigint NOT NULL DEFAULT 0,

    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- The recovery scan's only query. Partial, because terminal workflows are the majority in a
-- mature deployment and none of them are ever due.
CREATE INDEX IF NOT EXISTS records_due_idx
    ON workflow.records (lease_expires_at, next_wakeup_at)
    WHERE state NOT IN ('DONE', 'REJECTED', 'DENIED', 'CANCELLED', 'FAILED');

CREATE INDEX IF NOT EXISTS records_tenant_idx ON workflow.records (tenant_id, state);

-- Append-only. Contracts §3: "Every transition ... records a transition event", and the
-- WorkflowTransition contract keeps refusals too, so this table is the answer to "why did
-- nothing happen" as much as to "what changed".
CREATE TABLE IF NOT EXISTS workflow.transitions (
    id            text PRIMARY KEY,
    workflow_id   text NOT NULL REFERENCES workflow.records (id),
    -- Null for a refusal: no version was reached. Not zero, which is a real version.
    state_version bigint,
    accepted      boolean NOT NULL,
    occurred_at   timestamptz NOT NULL,
    transition    jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS transitions_workflow_idx
    ON workflow.transitions (workflow_id, occurred_at);

-- No UPDATE or DELETE grant on the transition log, for the same reason the audit chain is
-- append-only: a state history that can be edited is not evidence.
REVOKE UPDATE, DELETE ON workflow.transitions FROM PUBLIC;

COMMENT ON TABLE workflow.records IS
    'S2 workflow records. Compare-and-set on state_version; see services/workflow/src/sql-store.ts.';
COMMENT ON TABLE workflow.transitions IS
    'Append-only transition log, accepted and refused alike (contracts §3).';
