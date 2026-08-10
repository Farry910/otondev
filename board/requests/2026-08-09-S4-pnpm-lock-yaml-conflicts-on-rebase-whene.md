# Contract request - S4

- **Raised:** 2026-08-09 18:29
- **Card:** S4
- **By:** agent-f88c0410
- **Status:** open

## Need

pnpm-lock.yaml conflicts on rebase whenever two sessions add a workspace package. CLAUDE.md says a rebase conflict means a path-ownership rule was violated - that is not true for a generated lockfile, which is inherently shared. Resolved by regenerating (take main's copy, pnpm install, continue). Suggest either a lockfile merge driver or documenting regenerate-on-conflict, so the next session does not stop and report a defect that is not one.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->