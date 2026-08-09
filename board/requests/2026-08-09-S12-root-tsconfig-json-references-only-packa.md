# Contract request - S12

- **Raised:** 2026-08-09 14:52
- **Card:** S12
- **By:** agent-sess-ec39663a
- **Status:** open

## Need

Root tsconfig.json references only packages/*, so 'pnpm run typecheck' (and therefore 'pnpm run verify' and CI) never typechecks ANY services/* package. Verified: deleting services/verifier/dist and running 'tsc --build --force' does not rebuild it, exit 0. A type error in a Wave-1 service is invisible to CI -- I hit a real one (TS2345, string|null) that vitest happily ran past. Root 'build' has the same shape: pnpm -r --filter ./packages/** run build. Needs { path: './services/verifier' } added to tsconfig.json references and services/* added to the build filter. This affects every Wave-1 service, not just S12. Assumption I am building under: my package typechecks under 'npx tsc -b services/verifier --force', which I run in place of the root gate and which passes clean.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->