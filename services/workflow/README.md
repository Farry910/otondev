# S2 — Workflow Engine

The contracts §3 state machine, and the concurrency primitive the rest of the platform rests
on: compare-and-set on `state_version`, leases with monotonic fencing tokens, wakeups, retry
and backoff, compensation hooks, and the recovery scan.

Peers consume this through `WorkflowEngineClient` in `@otondev/sdk`. Nothing here should ever
be imported by another service.

## The one idea

**There is no `update`.** The storage port exposes exactly one way to change a workflow's
state — `commit(id, expectedVersion, mutate)` — which performs the compare-and-set, the
mutation, and the transition-event append as a single indivisible unit.

Everything else follows from that:

- *two claimants, exactly one wins* is a property of the store, not of careful calling;
- *a crash mid-transition* cannot leave a record that moved without its transition event, so a
  restarting engine never has to work out which half it is looking at;
- the mutator is **synchronous**, which is what stops anyone reintroducing an `await` between
  the version check and the write. Every asynchronous precondition — denying capabilities,
  calling a peer — happens *before* the critical section is entered.

Validation done on a snapshot and trusted after an `await` is the bug this package is shaped
to prevent, so every check that could change under us is re-run inside the mutator.

## Ordering that is not negotiable

Contracts §3: a pause or cancel "completes only after active capabilities are denied, the
current lease is fenced or safely checkpointed". So `transition(to: PAUSED | CANCELLED)`:

1. asks the containment port to deny capabilities — **if it will not confirm, nothing moves**;
2. runs compensation hooks (cancel only), and refuses with `COMPENSATION_UNAVAILABLE` if one
   throws, because a CANCELLED record over un-compensated external effects is how duplicates
   are born;
3. commits the state change, dropping the lease so the worker that never saw the pause is
   fenced on its next write.

An `unreachable` ack from the broker counts as a refusal. It is indistinguishable from "the
broker is wedged and still minting", which is the scenario the criterion exists for.

## Layout

| Path | What |
|---|---|
| `src/engine.ts` | the engine; holds no state |
| `src/store.ts` | the storage port — read this first |
| `src/memory-store.ts` | in-memory adapter; the conformance subject |
| `src/sql-store.ts` | Postgres reference implementation (see caveat below) |
| `src/sql-statements.ts` | every SQL string, shared by the store and the live verifier |
| `bin/verify-postgres.ts` | opt-in check against a real postgres:16.4 container |
| `src/containment.ts` | the pause/cancel precondition, as a narrow port over S5 |
| `src/backoff.ts` | retry schedule; deterministic unless jitter is injected |
| `migrations/001_workflow.sql` | the `workflow` schema's tables |

## Testing

```bash
pnpm vitest run services/workflow                     # unit + conformance, offline
npx tsc -p services/workflow/tsconfig.test.json       # typecheck the tests too
pnpm --filter @otondev/workflow run verify:postgres   # needs Docker; opt-in
```

The conformance test runs the shared suite from `packages/sdk` against **both** the fake and
this engine through the parity driver, so the failure it catches is divergence rather than
each side being independently plausible. Three negative controls break a specific guarantee
each and require the driver to notice — added because the suite went green the first time it
was run, which is when a suite deserves the least trust.

`verify:postgres` starts a `postgres:16.4-alpine` container, applies the migration, PREPAREs
every statement in `sql-statements.ts` against the live schema, and exercises the
compare-and-set, the fencing sequence and both scan predicates. It is not in `pnpm test`
because the workspace suite must stay offline — but it is worth running, because it caught DDL
that PostgreSQL refuses outright the first time it was used.

Two defects this package had and then caught, both worth knowing about:

- **A global quarantine contained nothing.** `quarantine()` enumerated with `due()`, which only
  returns workflows holding a lease or a wakeup — so an idle workflow was invisible and the ack
  said `contained: []`, which reads as success. It uses `active()` now, with a test that fails
  against the old behaviour.
- **The first migration could not be applied at all.** Its generated columns cast
  `text::timestamptz`, which is STABLE rather than IMMUTABLE, and PostgreSQL rejects a
  non-immutable generation expression. The two timestamp projections are maintained by a
  trigger instead, which keeps the no-drift property by a route the server allows. Only a real
  server finds that one.

## Caveats a reviewer should not have to discover

- **The SQL is verified; `SqlWorkflowStore` itself is not.** Every statement is exercised
  against a real postgres:16.4 by `verify:postgres`, and the unit tests assert they are issued
  in the right shape — CAS predicate on the `UPDATE`, record and transition inside one
  transaction. What has never run is this class over a real connection pool, because no driver
  is in the frozen lockfile. The remaining gap is one `SqlExecutor` adapter; whoever writes it
  should run `migrations/001_workflow.sql` first and should not assume the plumbing works
  merely because the SQL does.
- **Transition ids use a locally-minted `wft_` prefix.** `ID_PREFIX` has no `transition` kind;
  raised as a board request under `board/requests/`. Borrowing `aud_` or `evt_` would have made
  the id lie about what it identifies.
- **This package is not in the root `tsconfig.json` references**, so `pnpm run typecheck` does
  not cover it, and CI would not catch a type regression here. `npx tsc -b services/workflow`
  and `npm run typecheck:tests` both do, and both are clean. Raised as a board request — and it
  is not hypothetical: type errors did ship to `main` in the first commit because of it.
- **`recover()` leaves the workflow in `RECOVERING`** if the requested resume state is not
  reachable. That is deliberate — a workflow that needs an operator is better than one silently
  returned to a state the machine forbids — but it is a state an operator has to clear.
