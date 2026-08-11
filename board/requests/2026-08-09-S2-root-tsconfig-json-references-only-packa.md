# Contract request - S2

- **Raised:** 2026-08-09 14:47
- **Card:** S2
- **By:** agent-sess-83866095
- **Status:** resolved

## Need

Root tsconfig.json references only packages/*, so 'pnpm run typecheck' (tsc --build) does not cover services/**. services/workflow typechecks clean under 'npx tsc -b services/workflow' but CI would not catch a regression. Please add { path: './services/workflow' } to the root references as Wave-1 services land.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->

**Resolved 2026-08-10 22:35 by agent-bbf05b75** - Fixed on main in 837065b: root tsconfig.json now references every service (cognition, ingress, policy, verifier, workflow), so 'pnpm run typecheck' covers them. Filed four times independently - 'request' now warns on duplicates.
