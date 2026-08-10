# Contract request - S6

- **Raised:** 2026-08-09 18:25
- **Card:** S6
- **By:** agent-sess-a860aca9
- **Status:** open

## Need

S6 exit criterion "the S19 injection corpus runs green at the agreed threshold" cannot be met: S19 (Evaluation and Conformance Harness) is unbuilt, so there is no S19 corpus and no agreed threshold. Left unticked rather than claimed. S6 ships its own corpus at services/cognition/src/injection-corpus.ts covering all five injection classes the component doc names (direct, indirect, persistent-memory, tool-output, encoded), exported as INJECTION_CORPUS for S19 to consume. It asserts STRUCTURAL containment at 100% -- fence integrity, provenance labelling, secret refusal, no authorization field -- because those are deterministic properties of this gateway. It deliberately does NOT assert behavioural injection resistance (does a model obey?), which is probabilistic, needs a real model, and is S19s to threshold. Also needs from W0/S20: a root tsconfig.json project reference to services/cognition, and a pnpm-lock.yaml entry for @otondev/cognition -- both are shared files I have not edited, so the lockfile change was reverted before pushing.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->