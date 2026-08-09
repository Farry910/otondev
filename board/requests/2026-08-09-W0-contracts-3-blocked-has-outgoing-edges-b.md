# Contract request - W0

- **Raised:** 2026-08-09 13:01
- **Card:** W0
- **Status:** open

## Need

contracts §3: BLOCKED has outgoing edges but no incoming ones, so as written the state is unreachable. W0 treats it as operator-reachable from any non-terminal state via OPERATOR_REACHABLE in workflow-states.ts. Confirm or delete BLOCKED from that array.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->