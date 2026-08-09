-- One PostgreSQL instance, a schema per service, no cross-schema joins
-- (implementation-plan §2). Property 5 of an independently buildable package is that it
-- owns its storage schema and no peer reads its tables.
--
-- Each service gets a role that can use ONLY its own schema. That turns "no peer reads my
-- tables" from a code-review convention into a permission the database enforces, which is
-- the difference between a boundary and a preference.

\set ON_ERROR_STOP on

CREATE ROLE otondev_app NOLOGIN;

DO $$
DECLARE
    svc          text;
    schema_owner text;
    services     text[] := ARRAY[
        'ingress',    -- S1
        'workflow',   -- S2
        'core',       -- S3
        'policy',     -- S4
        'broker',     -- S5
        'cognition',  -- S6
        'actions',    -- S7  (external action + idempotency ledger)
        'audit',      -- S8
        'evidence',   -- S9
        'workspace',  -- S10
        'memory',     -- S13
        'presence',   -- S15
        'operator'    -- S18
    ];
BEGIN
    FOREACH svc IN ARRAY services LOOP
        schema_owner := format('otondev_%s', svc);

        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', schema_owner, 'dev-only-not-a-secret');
        EXECUTE format('GRANT %I TO otondev_app', schema_owner);
        EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I', svc, schema_owner);

        -- Deny by default, then grant exactly one schema back to exactly one role.
        EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', svc);
        EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', svc, schema_owner);
        EXECUTE format('ALTER ROLE %I SET search_path = %I', schema_owner, svc);
    END LOOP;
END
$$;

-- The migration runner for each service connects as its own role, so a migration that
-- reaches outside its schema fails at the database rather than in review.
COMMENT ON SCHEMA public IS
    'Intentionally empty. Every service owns a named schema; nothing shared lives here.';
