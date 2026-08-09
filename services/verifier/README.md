# S12 — Verifier and Definition of Done

The independent check that the work is actually done. Separate process from the executor
(implementation-plan §2), receives the goal, the diff, the definition of done and the evidence
— **never the executor's narrative** — and holds no publish capability.

## The one rule everything here serves

> A verdict can only be earned by evidence, and can only ever move downwards.

Nothing in this package can turn "did not run" into "pass". That is the whole design, and the
places it shows up are:

| Where | What it does |
|---|---|
| `manifest.ts` | fails closed on an unknown version, an unknown key, or a `forbidden` rule it cannot enforce |
| `verdict.ts` | `aggregateVerdict` caps at `inconclusive` if anything was skipped or unavailable |
| `verdict.ts` | `reconcileWithExecutorClaim` moves a verdict down, never up |
| `verdict.ts` | `projectVerifyInput` strips everything that is not one of the seven declared fields |
| `verifier.ts` | a broken runner or scanner becomes `unavailable`, never `fail` and never `pass` |
| `verifier.ts` | a check that observed a different commit or diff becomes `fail` |

## Why the ports are ports

`CheckRunner`, `Scanner`, `ConditionEvaluator` and `ManifestSource` are interfaces handed in at
construction. The verifier's authority is therefore exactly the union of what it was given —
it spawns nothing and opens no socket on its own — and a test can enumerate that. Which secret
scanner a deployment trusts is a deployment decision; what this package fixes is the contract
that a scanner which *cannot run* has a way to say so, and that saying so cannot produce a
passing verdict.

Checks run in a workspace created per attempt with `network_allowlist: []` — no egress at all.
A verifier that could reach the network could be told what to conclude by whatever answered.

## What it deliberately does not do

**It does not accept the executor's claim.** `verify()` has no parameter for it. The exit
criterion "executor says pass while verifier fails resolves as fail" is satisfied in the
strongest available form: there is no input through which the verdict could be talked upwards.
Reconciliation belongs to the caller that holds both, and `reconcileWithExecutorClaim` is
exported for it — a function that can only downgrade.

**It cannot publish.** No `publish`, `comment`, `approve`, `transition`, `merge` or `review`
method exists. `assertNoPublishSurface` proves it at runtime by walking the prototype chain,
and a test proves the guard itself fires.

## Conformance

`src/conformance.test.ts` runs `CONFORMANCE_SUITES.verifier` — the same suite object the fake
is held to, imported and never restated — against both `FakeVerifier` and `VerifierService`,
and asserts zero divergences.

It runs from here rather than from `packages/sdk/src/conformance/subjects.ts`, which the SDK
README suggests: `subjects.ts` is inside `packages/sdk`, and the `sdk-is-implementation-free`
boundary rule forbids that package from importing `services/`. See the two contract requests
raised on the S12 card.

## Building on it

```ts
import { VerifierService } from '@otondev/verifier';

const verifier = new VerifierService({
  workspace, evidence,          // peers, through their SDK interfaces
  clock, ids,                   // injected — every deadline here is a testable rule
  manifests, runner, scanners,  // the ports
  config: { verifierVersion: 'verifier-v3', workerImage, limits },
});
```

Tests: `npx vitest run services/verifier`. Typecheck: `npx tsc -b services/verifier --force`
— the root `pnpm run typecheck` does **not** cover `services/*` yet; that is one of the two
raised requests.
