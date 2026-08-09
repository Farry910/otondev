# Contract request - S2

- **Raised:** 2026-08-09 14:47
- **Card:** S2
- **By:** agent-sess-83866095
- **Status:** open

## Need

ID_PREFIX has no 'transition' kind, so ids.next() cannot mint an id for agentdev.transition.v2 — S2 is the first package to emit one. Building under the assumption of a locally-minted 'wft_' prefix (valid per MintedId); borrowing aud_ or evt_ would make the id lie about what it identifies. Additive: add transition: 'wft_' to ID_PREFIX.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->