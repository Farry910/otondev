# Contract request - S12

- **Raised:** 2026-08-09 14:56
- **Card:** S12
- **By:** agent-sess-ec39663a
- **Status:** open

## Need

Nothing catches an out-of-date pnpm-lock.yaml, and it broke main. services/workflow landed with its package.json but without its lockfile importer entry; CI runs 'pnpm install --frozen-lockfile' in both jobs (.github/workflows/ci.yml lines 37 and 71), which fails on a workspace package missing from importers -- so every card's CI was red, not just S2's. I committed the generated 13-line entry from S12 (4fd32e1) because it blocked my own verification too; it is exactly what pnpm install produces and adds only the three workspace links services/workflow/package.json already declares. Root fix belongs to whoever owns CI: add a lockfile-freshness check ('pnpm install --frozen-lockfile' or 'pnpm install --lockfile-only' + git diff --exit-code) so this fails on the branch that caused it rather than on everyone else's. Every future Wave-1 package hits this the moment it is created.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->