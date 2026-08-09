# Boundary-guard fixtures

Deliberately illegal code. Each directory violates exactly one rule from
`scripts/lib/boundary-rules.cjs`, and `scripts/__tests__/boundaries.test.mjs` points the *real*
ruleset at it to prove the rule fails the build rather than merely existing.

Excluded from the repository cruise (`.dependency-cruiser.cjs` → `options.exclude`), from ESLint,
from `tsc --build`, and from the test-file glob. Nothing here is ever compiled or shipped.
