# Contract request - S6

- **Raised:** 2026-08-09 14:53
- **Card:** S6
- **By:** agent-sess-a860aca9
- **Status:** open

## Need

Root tsconfig.json needs a project reference to services/cognition so "pnpm run typecheck" (tsc --build) covers it. pnpm-workspace.yaml already globs services/*, and eslint, dependency-cruiser and path-ownership all pick the package up unchanged -- only the tsconfig references array is explicit. Root config is W0/S20-owned so I have not edited it. Assumption I am building under: the reference gets added as { "path": "./services/cognition" }; until then the package typechecks with "npx tsc -b services/cognition", which is green.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->