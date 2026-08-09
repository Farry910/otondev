# @otondev/sdk — the seam

If you are a Wave-1 session, this is the only package you need to understand about your peers.

## What is here

| Thing | Where | Why it exists |
|---|---|---|
| a typed client interface per S1–S20 service | `src/services/` | you consume every peer through one of these, never through its source |
| a minimal in-memory fake per service | `src/fakes/` | so your tests run offline with all peers faked |
| the shared conformance suites | `src/conformance/suites.ts` | your fake and your implementation must both pass the same one |
| `deny()` / `quarantine()` / `revoke()` | `src/hooks.ts` | W0-E: every service implements these for emergency stop |
| structured logging, metrics, OTel | `src/observability/` | redaction and bounded cardinality, enforced not reviewed |

## Building against it

```ts
import type { ServiceRegistry } from '@otondev/sdk';

// Declare only the peers you need. You cannot reach one you did not declare.
export interface MyServiceDeps extends Pick<ServiceRegistry, 'policy' | 'audit'> {
  clock: Clock;
  ids: IdFactory;
}
```

and in your tests:

```ts
import { createFakeRegistry } from '@otondev/sdk';
import { FakeClock, deterministicIdFactory } from '@otondev/testkit';

const clock = new FakeClock('2026-07-30T08:00:00Z');
const { services } = createFakeRegistry({ clock, ids: deterministicIdFactory({ clock }) });
```

Pass the testkit's `FakeClock` and the whole registry becomes deterministic: same inputs, same
ids, same timestamps, every run. That is what makes a golden file or an evidence digest worth
comparing.

## Three things the type system enforces, so you do not have to remember them

- **The Cognition Gateway returns no authorization.** `CognitionResult` has no field an
  injected prompt could fill in to grant itself permission.
- **The Capability Broker never returns a secret.** There is no method that could.
- **The Verifier cannot publish.** No publish, comment, approve or transition method exists on
  `VerifierClient`, and a conformance case asserts none appears later.

## Your first commits

1. Deepen your service's fake in `src/fakes/` — a downstream session blocked on your fake is
   worse than your own package slipping (implementation-plan §6 rule 5). **This is the one
   file outside your `Owns` paths you are expected to touch**; raise it on your card's log.
2. Add `real:` to your entry in `src/conformance/subjects.ts` as soon as your implementation
   exists. `node scripts/conformance-report.mjs` then starts comparing the two, and until you
   do, the report says your parity is UNPROVEN — which it is.

## What you may not do

Import another service's source. The `no-cross-service` rule in
`scripts/lib/boundary-rules.cjs` fails the build, and `scripts/__tests__/boundaries.test.mjs`
proves the rule fires. If you need something the interface cannot express, raise a contract
request (`board.ps1 request <ID> -Note "..."`) and keep building under a stated assumption.
