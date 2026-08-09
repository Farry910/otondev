# Contract request - SP3

- **Raised:** 2026-08-09 14:46
- **Card:** SP3
- **By:** agent-sess-a860aca9
- **Status:** open

## Need

SP3 cannot progress without a Ditto offline licence token. Observed on the real SDK: sync.start() throws "Sync could not be started because Ditto has not yet been activated ... visit portal.ditto.live". Local CRUD works unactivated; only replication is gated. The 5 unticked criteria are all two-peer. Harness is written, typechecks, and skips cleanly: set DITTO_OFFLINE_LICENSE_TOKEN and run npm run sync-suite. A human needs to obtain the token or gate this card.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->