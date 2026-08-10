# S19 — Evaluation and Conformance Harness

The gate. W0 shipped a conformance runner, a fake-parity driver, and a script that **prints**.
Printing is a report; a gate returns an exit code. This package is the difference.

One rule runs through all of it, inherited from S12: **a check that could not run is never a
pass.** A safety harness that reports green when it is broken is worse than no harness, because
it is believed.

## What decides the build

| Outcome | Fails the build? | Why |
|---|---|---|
| `fail` + `safety` | **yes** | the thing the harness exists for |
| `fail` + `correctness` | **yes** | blocking on injection while waving through a broken contract enforces the rarer risk |
| `fail` + `quality` | no | cost and latency move for outside reasons; a gate that blocks on them gets bypassed, and a bypassed gate protects nothing — including the safety checks sharing its exit code |
| `unavailable` | no | the harness could not answer. Reported loudly, never counted as a pass |

## Suites

- **`faults`** — eight classes (process, worker, host, network, provider, token, storage, bad
  rollout). Each asserts the fault *reaches the caller*: the commonest way fault handling
  breaks is a `catch {}` that returns success.
- **`adversarial`** — direct, indirect, encoded and multimodal injection, declared as data so
  the same payloads run through every channel as it lands. Channels with no implementation are
  `unavailable`, named individually rather than averaged away.
- **`canary`** — a credential-shaped value planted where a secret would be, watched across all
  eight exfiltration channels. Substring, not equality: a canary in a URL query has still left
  the building. The report never quotes the canary back — that would make it the ninth channel.
- **`benchmark`** — frozen, content-addressed tasks with hidden tests. The attempt receives a
  `VisibleTask`, which has no field the hidden tests occupy, so the hiding is structural rather
  than conventional. An attempt's own `claim: 'done'` cannot make it complete.
- **`regression`** — cost and latency against a baseline keyed by the *pinned version tuple*.
  A different tuple is a **rebaseline**, not a regression: calling a deliberate model change a
  regression trains everyone to ignore the signal, and calling it a pass hides the cost.
- **`coverage`** — reads every card's exit criteria from `board/packages/*.md` and classifies
  each as `harness`, `package` or `manual`. Unclassified is a failure, so whoever adds a
  criterion says how it is expressed *when they add it*.
- **`conformance`** — every fake against its suite, converted to findings. A failing fake is a
  **safety** finding: every session builds against it without reading the peer's source.

## Real implementations live here, not in the seam

The SDK README asks each session to register its implementation in
`packages/sdk/src/conformance/subjects.ts`, but `sdk-is-implementation-free` forbids
`packages/sdk` from importing `services/` — correctly, or the seam would depend on the things
it exists to decouple. Nothing forbids `eval` from importing a service, so `REAL_SUBJECTS`
belongs here.

They load dynamically and degrade to `unavailable` when their build output is missing, which is
the state in CI today: root `tsconfig.json` references only `packages/*`, so `services/*` is
never built. Raised as a contract request.

**Where real parity is proven today.** Not here — from each service's own package. `S12`'s and
`S1`'s `conformance.test.ts` each run `runFakeParity({ suite, fake, real })` with the real
implementation and assert zero divergences, and those run under the same `pnpm run test` CI
invocation as this harness. So W0's driver *is* comparing real implementations in CI; what this
registry adds is one place to see them all, and it reports `unavailable` rather than borrowing
a result it did not observe. When the tsconfig request lands, these rows become real
comparisons here too.

## Known gaps

`gaps.ts` downgrades a pre-existing defect from `fail` to `unavailable` — it is not a
*regression*, and turning main red on the day the harness lands gets the harness disabled
rather than the gap fixed. Three constraints stop that becoming a mute button: every entry
names a raised request and an owning card, and a suppression matching nothing is itself a
build failure. Anything not on the list still fails.

One entry today: **the SDK logger redacts by field name**, so a credential in a free-text
`detail` field reaches the sink verbatim. Found by this harness on its first run.

Tests: `npx vitest run eval` — and `pnpm run test`, which CI runs, globs `eval/**/*.test.ts`,
so the harness runs in CI with no workflow edit.
