# Contract request - S12

- **Raised:** 2026-08-09 14:52
- **Card:** S12
- **By:** agent-sess-ec39663a
- **Status:** open

## Need

packages/sdk/README.md tells every Wave-1 session: 'Add real: to your entry in src/conformance/subjects.ts as soon as your implementation exists.' That instruction cannot be followed. subjects.ts lives in packages/sdk, and the sdk-is-implementation-free boundary rule (scripts/lib/boundary-rules.cjs) forbids packages/sdk/ from importing services/. Wiring real: there fails the boundary cruise -- correctly, since the seam must not depend on an implementation. Consequence: 'node scripts/conformance-report.mjs' will report every service suite as UNPROVEN forever, and its closing message tells sessions to do the impossible thing. S12 satisfies the exit criterion by running the SAME suite object (CONFORMANCE_SUITES.verifier, imported not restated) against both fake and real from services/verifier/src/conformance.test.ts via runFakeParity -- 0 divergences. Suggested fix: either an inversion-of-control registry the report reads at runtime, or amend the README to point sessions at the in-package parity test.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->