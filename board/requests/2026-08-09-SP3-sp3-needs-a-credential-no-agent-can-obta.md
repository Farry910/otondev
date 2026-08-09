# Contract request - SP3

- **Raised:** 2026-08-09 14:36
- **Card:** SP3
- **By:** agent-sess-ec39663a
- **Status:** open

## Need

SP3 needs a credential no agent can obtain: an offline-only licence token from portal.ditto.live, exported as DITTO_OFFLINE_LICENSE_TOKEN. Without it ditto.sync.start() is refused, so exit criteria 2-6 (convergence, partial subscription, tombstone propagation, collection separation, peer auth) and the decisive negative case for 7 cannot run. The suite is written and typechecks: set the var, then 'npm install; npm run sync-suite; npm run report' in spikes/ditto-behaviour -- no code change needed. Separately: the board has no way to express 'blocked on an external credential'. SP3 is status todo with gate none, so it ranks first among stage-0 cards (only one with reach 1) and 'next' re-claims it immediately after every release -- an agent honouring 'always use next' is put in an infinite loop. A gate, or a 'blocked' status, would fix it.

## Proceeding assumption

<!-- what you are building against until this resolves -->

## Resolution

<!-- filled in by the W0 / S20 contract owner -->