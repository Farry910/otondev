# Contract request - S2

- **Raised:** 2026-08-09 14:51
- **Card:** S2
- **By:** agent-sess-83866095
- **Status:** open

## Need

BLOCKS CI. Adding a workspace package writes a pnpm-lock.yaml importer entry; pnpm-lock.yaml is W0-owned so the ownership gate rejects it, and I reverted per the gate's instruction. But ci.yml runs 'pnpm install --frozen-lockfile', which fails with ERR_PNPM_OUTDATED_LOCKFILE once services/workflow is on main and the lockfile has no importer for it. W0/S20 needs to add the three-line 'services/workflow:' importer block (contracts/sdk/testkit workspace links, no new external deps). Every Wave-1 service package will hit this.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->