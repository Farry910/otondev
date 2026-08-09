# Contract request - S2

- **Raised:** 2026-08-09 14:47
- **Card:** S2
- **By:** agent-sess-83866095
- **Status:** open

## Need

Root tsconfig.json references only packages/*, so 'pnpm run typecheck' (tsc --build) does not cover services/**. services/workflow typechecks clean under 'npx tsc -b services/workflow' but CI would not catch a regression. Please add { path: './services/workflow' } to the root references as Wave-1 services land.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->