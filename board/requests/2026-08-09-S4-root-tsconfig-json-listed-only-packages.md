# Contract request - S4

- **Raised:** 2026-08-09 18:25
- **Card:** S4
- **By:** agent-f88c0410
- **Status:** resolved

## Need

Root tsconfig.json listed only packages/*, so services/policy was not typechecked by 'tsc --build' at all. Added a project reference. Every future service needs the same one-line addition to a W0/S20-owned file; consider whether the solution file should be generated from the workspace globs instead.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->

**Resolved 2026-08-10 22:35 by agent-bbf05b75** - Fixed on main in 837065b: root tsconfig.json now references every service (cognition, ingress, policy, verifier, workflow), so 'pnpm run typecheck' covers them. Filed four times independently - 'request' now warns on duplicates.
