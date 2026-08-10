# Contract request - S4

- **Raised:** 2026-08-09 18:25
- **Card:** S4
- **By:** agent-f88c0410
- **Status:** open

## Need

PolicyQuery in packages/sdk carries no estimated_cost_usd and no approval_id, but implementation-plan section 5 S4 requires evaluation over cost and approval. S4 accepts a widened PolicyEvaluationQuery (both optional, so an SDK-typed query is still valid) and treats absent cost as 0 and absent approval as none. Please add both as optional fields to PolicyQuery.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->