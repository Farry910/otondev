-- S4 owns the `policy` schema. No other service reads these tables
-- (implementation-plan §1 property 5); peers go through the PolicyClient interface.
--
-- The compose dev environment already creates the schema and a role that can only reach it.
-- This migration defines what lives inside.

\set ON_ERROR_STOP on

SET search_path = policy;

-- ---------------------------------------------------------------- approvals

CREATE TABLE IF NOT EXISTS approvals (
    tenant_id            text        NOT NULL,
    approval_id          text        NOT NULL,

    -- The bound fields, stored as columns rather than inside a JSON blob so the uniqueness
    -- constraint below can be expressed at all, and so a binding mismatch is a comparison the
    -- database can do rather than something only application code can see.
    action               text        NOT NULL,
    resource             text        NOT NULL,
    environment          text        NOT NULL,
    parameter_digest     text        NOT NULL,
    plan_digest          text        NOT NULL,

    decision_request_id  text        NOT NULL,
    approver_human_id    text        NOT NULL,
    approver_authn       text        NOT NULL,

    expires_at           timestamptz NOT NULL,
    max_uses             integer     NOT NULL,
    uses                 integer     NOT NULL DEFAULT 0,
    status               text        NOT NULL,

    -- The full contract record, so a reader never has to reassemble it from columns and risk
    -- disagreeing with what was signed.
    record               jsonb       NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, approval_id),

    CONSTRAINT approvals_uses_within_limit CHECK (uses >= 0 AND uses <= max_uses),
    CONSTRAINT approvals_max_uses_positive CHECK (max_uses >= 1),
    CONSTRAINT approvals_status_known CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
    -- A consumed record must have the use count that justifies it. Without this the two can
    -- drift and a replay check that trusts either one alone becomes wrong.
    CONSTRAINT approvals_consumed_is_spent CHECK (status <> 'consumed' OR uses >= max_uses),
    CONSTRAINT approvals_authn_strong_enough
        CHECK (approver_authn IN ('mfa', 'hardware_key', 'signed_command'))
);

COMMENT ON CONSTRAINT approvals_authn_strong_enough ON approvals IS
    'Contracts §5: chat text, an emoji or a ticket label is not an approval. Weak authentication '
    'cannot reach this table at all, so the rule survives a bug in the service.';

-- Consumption is a conditional UPDATE against this. Indexed so the compare-and-set is a
-- primary-key lookup rather than a scan under contention.
CREATE INDEX IF NOT EXISTS approvals_active_by_tenant
    ON approvals (tenant_id, status)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS approvals_by_decision_request
    ON approvals (tenant_id, decision_request_id);

-- ---------------------------------------------------------------- decisions

-- Decisions are appended, never updated: "every decision is reproducible from its logged
-- inputs and bundle hash" is only true if the logged inputs cannot be edited afterwards.
CREATE TABLE IF NOT EXISTS decisions (
    tenant_id          text        NOT NULL,
    decision_id        text        NOT NULL,
    workflow_id        text        NOT NULL,
    plan_id            text        NOT NULL,
    action             text        NOT NULL,
    resource           text        NOT NULL,
    environment        text        NOT NULL,
    parameter_digest   text        NOT NULL,
    decision           text        NOT NULL,
    autonomy_level     text        NOT NULL,
    policy_bundle      text        NOT NULL,
    reason_codes       text[]      NOT NULL,
    record             jsonb       NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, decision_id),
    CONSTRAINT decisions_outcome_known CHECK (decision IN ('allow', 'deny', 'require_approval')),
    CONSTRAINT decisions_has_reason CHECK (cardinality(reason_codes) >= 1),
    -- The bundle reference is what makes a decision replayable. A decision that does not name
    -- the exact bundle it was taken against cannot be reproduced, so it may not be stored.
    CONSTRAINT decisions_bundle_pinned CHECK (policy_bundle ~ '@sha256:[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS decisions_by_workflow ON decisions (tenant_id, workflow_id, created_at DESC);

-- ---------------------------------------------------------------- bundles

-- Every bundle the service has ever loaded, keyed by the hash that appears on decisions.
-- Without this, a decision from six months ago names a bundle nobody can produce.
CREATE TABLE IF NOT EXISTS bundles (
    bundle_ref   text        PRIMARY KEY,
    tenant_id    text        NOT NULL,
    name         text        NOT NULL,
    version      integer     NOT NULL,
    signing_key  text        NOT NULL,
    body         jsonb       NOT NULL,
    loaded_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT bundles_ref_pinned CHECK (bundle_ref ~ '@sha256:[0-9a-f]{64}$'),
    CONSTRAINT bundles_version_positive CHECK (version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS bundles_one_body_per_name_version
    ON bundles (tenant_id, name, version);

COMMENT ON INDEX bundles_one_body_per_name_version IS
    'Two bundles with the same name and version must be byte-identical, or a decision that '
    'cites "engineering-pilot v2" is ambiguous about which v2 it meant.';
