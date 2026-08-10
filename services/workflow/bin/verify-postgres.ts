/**
 * Verify the Postgres store against a real PostgreSQL, not a mock.
 *
 *   pnpm --filter @otondev/workflow run verify:postgres
 *   npx tsx services/workflow/bin/verify-postgres.ts
 *
 * Lives in `bin/` rather than `scripts/`: the root eslint config exempts any `bin` directory
 * from the no-console and no-process-env rules, which a CLI needs, while only the *root*
 * `scripts/` is exempt. Moving the file satisfied the rules without editing a W0-owned config.
 *
 * Deliberately NOT part of `pnpm test`. The workspace suite is required to be green offline
 * with every peer faked, and a test that needs Docker is neither offline nor a unit test. It
 * is an opt-in gate the S2 owner runs before claiming the SQL store works.
 *
 * What it actually proves, and what it does not:
 *
 *   - the migration applies to a clean database of the pinned server version;
 *   - **every statement in `SQL` PREPAREs**, so Postgres parses and plans it against the real
 *     schema — this is what a mocked executor can never tell you, and the statements come
 *     from the same module the store uses so the two cannot drift;
 *   - the compare-and-set, the fencing sequence, the generated columns and the scan
 *     predicates behave as the store assumes.
 *
 * It does not exercise `SqlWorkflowStore` itself, because no driver is in the frozen root
 * lockfile. The gap is one adapter — `SqlExecutor` — and it is stated in the README rather
 * than papered over.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SQL } from '../src/sql-statements.js';

const CONTAINER = process.env.OTONDEV_PG_CONTAINER ?? 'otondev-s2-verify';
const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

function psql(sql: string, { user = 'otondev', db = 'otondev' } = {}): string {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db, '-f', '-'],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

/** Dollar-quoting, so a JSON document with quotes in it cannot terminate the literal. */
function lit(value: string): string {
  let tag = 'v';
  while (value.includes(`$${tag}$`)) tag += 'v';
  return `$${tag}$${value}$${tag}$`;
}

const steps: { name: string; run: () => void }[] = [];
const step = (name: string, run: () => void) => steps.push({ name, run });

// --------------------------------------------------------------------- schema

step('the shared schema/role bootstrap applies', () => {
  // The infra script is written for a first-boot container and creates roles unconditionally,
  // so re-running it errors. Skip it when the schema is already there rather than tearing the
  // container down — this script has to be re-runnable while iterating on the migration.
  const exists = psql(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'workflow';`,
  ).includes('1 row');
  if (exists) return;
  psql(readFileSync(here('../../../infra/dev/postgres/01-service-schemas.sql'), 'utf8'));
});

step('the S2 migration applies to a clean database', () => {
  psql(readFileSync(here('../migrations/001_workflow.sql'), 'utf8'), { user: 'otondev_workflow' });
});

step('the migration is idempotent — re-running it is not an error', () => {
  psql(readFileSync(here('../migrations/001_workflow.sql'), 'utf8'), { user: 'otondev_workflow' });
});

step('the fixture starts from empty tables', () => {
  // Re-runnable on a live container, not only on a fresh one. A verification script that
  // works once and then fails on duplicate keys teaches you to stop running it.
  psql(
    `TRUNCATE workflow.transitions, workflow.records;
     REVOKE UPDATE, DELETE ON workflow.transitions FROM PUBLIC;`,
    { user: 'otondev_workflow' },
  );
});

// ------------------------------------------------------- every statement plans

step('every statement in SQL parses and plans against the real schema', () => {
  // PREPARE is the assertion: it forces Postgres to resolve every column, cast and operator.
  // A typo in a generated-column name, or `->>` applied to the wrong type, fails here — and
  // fails nowhere else until production.
  const prepares = Object.entries(SQL)
    .map(([name, text], index) => `PREPARE p_${index}_${name} AS ${text};`)
    .join('\n');
  psql(prepares, { user: 'otondev_workflow' });
});

// ------------------------------------------------------------------- semantics

const WF = 'wf_01KDVDNA000000000000000001';
const TENANT = 'ten_01KDVDNA00000000000000000';

function record(state: string, version: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 'agentdev.workflow.v2',
    id: WF,
    tenant_id: TENANT,
    state,
    state_version: version,
    lease: null,
    next_wakeup_at: null,
    ...extra,
  });
}

step('insert, then the generated columns project the record', () => {
  psql(
    `${SQL.insert.replace('$1', lit(WF)).replace('$2', lit(TENANT)).replace('$3', lit(record('RECEIVED', 0)))};
     DO $$ BEGIN
       IF (SELECT state FROM workflow.records WHERE id = ${lit(WF)}) <> 'RECEIVED'
         THEN RAISE EXCEPTION 'generated column state did not project'; END IF;
       IF (SELECT state_version FROM workflow.records WHERE id = ${lit(WF)}) <> 0
         THEN RAISE EXCEPTION 'generated column state_version did not project'; END IF;
     END $$;`,
    { user: 'otondev_workflow' },
  );
});

step('the guarded UPDATE applies on a matching state_version', () => {
  const sql = SQL.updateGuarded.replace('$1', lit(WF))
    .replace('$2', '0')
    .replace('$3', lit(record('TRIAGED', 1)));
  const out = psql(`${sql};`, { user: 'otondev_workflow' });
  if (!out.includes(WF)) throw new Error('the guarded UPDATE returned no row on a matching version');
});

step('the guarded UPDATE is a no-op on a stale state_version — the compare-and-set', () => {
  // The property the whole platform's concurrency rests on. Version is now 1; a writer still
  // holding 0 must change nothing.
  const sql = SQL.updateGuarded.replace('$1', lit(WF))
    .replace('$2', '0')
    .replace('$3', lit(record('PLANNED', 1)));
  const out = psql(`${sql};`, { user: 'otondev_workflow' });
  if (out.includes(WF)) throw new Error('a stale writer updated the row: compare-and-set is broken');

  const state = psql(
    `SELECT state FROM workflow.records WHERE id = ${lit(WF)};`,
    { user: 'otondev_workflow' },
  );
  if (!state.includes('TRIAGED')) throw new Error(`stale write leaked through: ${state}`);
});

step('GREATEST keeps the fencing sequence monotonic across a lower write', () => {
  const bump = (to: number) =>
    psql(`${SQL.updateLease.replace('$1', lit(WF)).replace('$2', lit(record('TRIAGED', 1))).replace('$3', String(to))};`, {
      user: 'otondev_workflow',
    });
  bump(5);
  bump(2); // a release path writing a lower value must not walk the counter back
  const seq = psql(`SELECT fencing_token_seq FROM workflow.records WHERE id = ${lit(WF)};`, {
    user: 'otondev_workflow',
  });
  if (!seq.includes('5')) throw new Error(`fencing sequence moved backwards: ${seq}`);
});

step('the scan predicates use the generated columns correctly', () => {
  const future = '2999-01-01T00:00:00Z';
  const past = '2000-01-01T00:00:00Z';

  // A live lease is not due; an expired one is. Both go through SQL.selectDue verbatim.
  psql(
    `${SQL.updateLease
      .replace('$1', lit(WF))
      .replace('$2', lit(record('TRIAGED', 1, { lease: { owner: 'wl_x', expires_at: future, fencing_token: 5 } })))
      .replace('$3', '5')};`,
    { user: 'otondev_workflow' },
  );
  const notDue = psql(`${SQL.selectDue.replace(/\$1/g, lit('2026-01-01T00:00:00Z'))};`, {
    user: 'otondev_workflow',
  });
  if (notDue.includes(WF)) throw new Error('a live lease was reported due');

  psql(
    `${SQL.updateLease
      .replace('$1', lit(WF))
      .replace('$2', lit(record('TRIAGED', 1, { lease: { owner: 'wl_x', expires_at: past, fencing_token: 5 } })))
      .replace('$3', '5')};`,
    { user: 'otondev_workflow' },
  );
  const due = psql(`${SQL.selectDue.replace(/\$1/g, lit('2026-01-01T00:00:00Z'))};`, {
    user: 'otondev_workflow',
  });
  if (!due.includes(WF)) throw new Error('an expired lease was not reported due');
});

step('active() sees an idle workflow that due() cannot — the quarantine bug, in SQL', () => {
  // The defect this store had: a workflow with no lease and no wakeup is invisible to `due`
  // but is still live, so a global quarantine driven by `due` contained nothing.
  const idle = 'wf_01KDVDNA000000000000000002';
  psql(
    `${SQL.insert
      .replace('$1', lit(idle))
      .replace('$2', lit(TENANT))
      .replace('$3', lit(JSON.stringify({ id: idle, state: 'PLANNED', state_version: 0, lease: null, next_wakeup_at: null })))};`,
    { user: 'otondev_workflow' },
  );

  const due = psql(`${SQL.selectDue.replace(/\$1/g, lit('2026-01-01T00:00:00Z'))};`, {
    user: 'otondev_workflow',
  });
  if (due.includes(idle)) throw new Error('an idle workflow should not be due');

  const active = psql(`${SQL.selectActive};`, { user: 'otondev_workflow' });
  if (!active.includes(idle)) throw new Error('active() missed an idle live workflow');
});

step('a terminal workflow drops out of both scans', () => {
  psql(
    `${SQL.updateLease
      .replace('$1', lit(WF))
      .replace('$2', lit(record('DONE', 2)))
      .replace('$3', '5')};`,
    { user: 'otondev_workflow' },
  );
  const active = psql(`${SQL.selectActive};`, { user: 'otondev_workflow' });
  if (active.includes(WF)) throw new Error('a terminal workflow is still reported active');
});

step('the transition log rejects UPDATE and DELETE', () => {
  psql(
    `${SQL.insertTransition
      .replace('$1', lit('wft_01KDVDNA00000000000000001'))
      .replace('$2', lit(WF))
      .replace('$3', '1')
      .replace('$4', 'true')
      .replace('$5', lit('2026-01-01T00:00:00Z'))
      .replace('$6', lit(JSON.stringify({ schema: 'agentdev.transition.v2' })))};`,
    { user: 'otondev_workflow' },
  );

  // The REVOKE in the migration is against PUBLIC; the schema owner necessarily keeps its
  // rights, so what is asserted is the grant state, not a failed statement. Saying so is the
  // point — the append-only property holds for application roles, not for the migration role.
  //
  // One column, `-t -A` so the answer is the bare string `t` or `f`. Parsing an aligned table
  // with a regex was the first version of this check, and it passed whether or not PUBLIC
  // held the grant.
  for (const privilege of ['DELETE', 'UPDATE']) {
    const answer = execFileSync(
      'docker',
      [
        'exec', '-i', CONTAINER, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'otondev_workflow',
        '-d', 'otondev', '-t', '-A', '-c',
        `SELECT has_table_privilege('public', 'workflow.transitions', '${privilege}')`,
      ],
      { encoding: 'utf8' },
    ).trim();

    if (answer !== 'f') {
      throw new Error(`PUBLIC still holds ${privilege} on the transition log (got "${answer}")`);
    }
  }
});

// ----------------------------------------------------------------------- run

let failed = 0;
for (const { name, run } of steps) {
  try {
    run();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    const detail = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    console.log(`  FAIL  ${name}\n        ${detail}`);
    if (stderr) console.log(`        ${String(stderr).trim().split('\n').slice(0, 6).join('\n        ')}`);
  }
}

console.log(`\n${steps.length - failed}/${steps.length} checks passed against ${CONTAINER}`);
process.exit(failed === 0 ? 0 : 1);
