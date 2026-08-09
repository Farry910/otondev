# Contract request - S2

- **Raised:** 2026-08-09 14:47
- **Card:** S2
- **By:** agent-sess-83866095
- **Status:** open

## Need

contracts §11 has no error code for 'a containment precondition could not be satisfied'. When a pause/cancel is refused because the broker would not confirm the capability deny, S2 currently throws INTERNAL with details.reason='capabilities could not be denied'. INTERNAL is retryable-ambiguous and reads as a bug rather than a refusal. Additive: a CONTAINMENT_INCOMPLETE code (non-retryable, component 'workflow', transition null).

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->