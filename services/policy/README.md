# S4 — Policy and Approval

Deterministic evaluation, effective-autonomy floors, signed policy bundles, and approvals
bound to exactly what was approved. Consumed through `PolicyClient` in `@otondev/sdk`.

**Security-critical.** This card does not go to `done` on the implementing session's judgment
(implementation-plan §7). The section at the bottom is written for whoever reviews it.

## Shape

```
src/normalize.ts   canonical encoding + parameter digest      ← everything rests on this
src/bundle.ts      bundle schema, signing, verified loading
src/autonomy.ts    effective autonomy = min across dimensions
src/evaluate.ts    the decision, as a pure function
src/approvals.ts   binding and lifecycle, as pure functions
src/store.ts       PolicyStore + in-memory implementation
src/service.ts     the only part that touches clock, store and audit
migrations/        the `policy` Postgres schema S4 owns
```

The split between pure and impure is load-bearing, not tidiness. "Every decision is
reproducible from its logged inputs and bundle hash" is a property a pure function has for
free and a stateful one can only promise.

## The three things most worth understanding

**Unknown denies, and it is checked before anything permissive can happen.** Every autonomy
lookup returns a level *or* an unknown marker; there is no default that quietly means A4. An
action with no rule, a resource not in the bundle, an empty data-class set and a tenant the
bundle does not govern are all denies, and the denial reports `A0` rather than a level it
could not establish.

**Effective autonomy is a minimum over six dimensions**, one of which is incident mode. It
participates in the same minimum as everything else rather than being a special branch,
because a special branch is what gets forgotten. Each decision reports the dimensions that
pinned the number, so "why A1?" has an answer.

**An approval is a bound record, never an interpretation.** The binding check iterates
`APPROVAL_BOUND_FIELDS` from the contract, so adding a bound field there and forgetting it
here fails a test. There is no method anywhere in this service that takes prose and decides
whether it meant yes, and `createApproval` refuses any approver below MFA — the database
`CHECK` refuses them too, so the rule survives a bug in the service.

## Running it

```bash
pnpm --filter @otondev/policy build
pnpm test                     # offline, every peer faked
```

Apply the schema (the compose dev environment already creates the schema and its role):

```bash
psql "$POLICY_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/0001_policy_schema.sql
```

## Deliberately not built yet

**A PostgreSQL `PolicyStore`.** The interface, its compare-and-set contract and the schema all
exist, and the schema was applied to a real PostgreSQL 16 and its constraints checked to
actually reject weak approvers, unspent-but-consumed rows, unpinned bundle references and
reasonless decisions. The adapter itself is not written, because a database adapter that the
offline suite cannot exercise is a component with no tests, and `pnpm test` must stay green
with no network. It wants its own pass with a store-level conformance suite run against both
implementations — the same shape S13/S14 use for `MemoryStore`.

**Decision and bundle persistence.** `decisions` and `bundles` are in the schema and unused by
the service; today decisions go to audit (S8) and the bundle is supplied at construction.

## For the reviewer

Where I would look hardest, in order:

1. **`normalize.ts`.** If two different parameter sets can digest the same, every approval in
   the system is forgeable. `test/normalize.test.ts` covers key order, null vs absent, array
   order, case, and a crafted-key collision, but the argument is adversarial and deserves a
   second pair of eyes.
2. **The check order in `evaluate.ts`.** First refusal wins, and the order decides which
   reason a caller sees. I put tenant and secret-class first, then unknown-resource and
   unknown-action, before anything that could produce an allow. Convince yourself no path
   reaches an allow with an input the bundle never described.
3. **`checkConsumable` ordering in `approvals.ts`.** Binding is checked before expiry so the
   more specific answer wins. That is a usability call, not a security one — but confirm it
   cannot leak whether an approval exists for a binding the caller did not already know.
4. **`meetsAuthnStrength`.** `signed_command` ranks equal to `mfa` deliberately
   (implementation-plan §5 S18 treats it as the out-of-band administrative path). If that is
   wrong, it is wrong in a way that matters.
5. **The audit swallow in `service.ts`.** A failed audit write does not fail the decision. I
   believe that is right — an audit outage should not become a policy outage — but it does
   mean a decision can happen without a record, and S8 owns closing that gap with durable
   buffering. Worth disagreeing with if you disagree.

Two contract requests were raised while building this; both are recorded on the card:
`PolicyQuery` has no field for estimated cost or a supplied approval id (the service accepts a
widened type meanwhile), and the root `tsconfig.json` needed a project reference so the
service is typechecked at all.
