-- S2 owns the `workflow` schema. The schema and its role are created by
-- infra/dev/postgres/01-service-schemas.sql; this migration creates the tables inside it and
-- is run as the `otondev_workflow` role, whose search_path is already `workflow`.
--
-- Verified against postgres:16.4-alpine by services/workflow/scripts/verify-postgres.ts.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS workflow.records (
    id                     text PRIMARY KEY,
    tenant_id              text NOT NULL,
    -- The whole enveloped record. Kept as jsonb rather than shredded into columns because
    -- contracts §12 requires readers to support the current and one prior major version, and
    -- a column-per-field table makes that a migration every time a field is added.
    record                 jsonb NOT NULL,

    -- Projected out of the record because each is either a predicate in a scan or the target
    -- of the compare-and-set. Generated, so they cannot drift from the record: the
    -- application has no way to set them.
    state                  text   GENERATED ALWAYS AS (record ->> 'state') STORED,
    state_version          bigint GENERATED ALWAYS AS ((record ->> 'state_version')::bigint) STORED,

    -- The two timestamps are maintained by the trigger below rather than generated, and the
    -- reason is not stylistic: `text::timestamptz` is STABLE, not IMMUTABLE — it depends on
    -- the session TimeZone — and PostgreSQL rejects a non-immutable generation expression
    -- outright ("generation expression is not immutable"). A trigger may call stable
    -- functions, so it gets the same no-drift property by a route the server allows.
    lease_expires_at       timestamptz,
    next_wakeup_at         timestamptz,

    -- Monotonic per workflow, and deliberately NOT derived from the record: a released lease
    -- sets `record.lease` to null, and a counter that lived there would restart at 1 and let
    -- a stale worker's token be accepted by the next holder.
    fencing_token_seq      bigint NOT NULL DEFAULT 0,

    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION workflow.project_record_timestamps()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Read from the record and nowhere else. Any value the caller put in these columns is
    -- discarded, which is what keeps them honest.
    NEW.lease_expires_at := (NEW.record #>> '{lease,expires_at}')::timestamptz;
    NEW.next_wakeup_at   := (NEW.record ->> 'next_wakeup_at')::timestamptz;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS project_record_timestamps ON workflow.records;
CREATE TRIGGER project_record_timestamps
    BEFORE INSERT OR UPDATE OF record ON workflow.records
    FOR EACH ROW EXECUTE FUNCTION workflow.project_record_timestamps();

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

-- A state history that can be edited is not evidence. The schema owner necessarily retains
-- rights (it just created the table); this revokes the application-facing grants, and the
-- deployment grants SELECT/INSERT only to the runtime role.
REVOKE UPDATE, DELETE ON workflow.transitions FROM PUBLIC;

COMMENT ON TABLE workflow.records IS
    'S2 workflow records. Compare-and-set on state_version; see services/workflow/src/sql-store.ts.';
COMMENT ON TABLE workflow.transitions IS
    'Append-only transition log, accepted and refused alike (contracts §3).';
