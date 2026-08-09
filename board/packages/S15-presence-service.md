# S15 — Presence Service

```yaml
id: S15
status: blocked
owner: ""
claimed_at: ""
branch: svc/S15-presence
stage: 3
gate: W0 + meeting platform decision
fake: no
```

**Owns** — `services/presence/**`
**Spec** — implementation plan §5 · S15 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [presence-service](../../doc/02-architecture/components/presence-service.md)

> **Blocked on an unmade decision**, not a spike: no meeting platform has been chosen. Only the
> platform adapter is affected — the lifecycle FSM, consent, and turn-taking logic could start early
> if the decision is imminent.

## Exit criteria

- [ ] meeting lifecycle FSM with the documented safe defaults after uncertainty or reconnect
- [ ] authorization and consent preflight; disclosure at join
- [ ] voice provider adapter behind a stable interface; typed **read-only** functions only
- [ ] turn-taking: platform events, VAD, address detection, interruption
- [ ] the grounded-response gate — "tests pass" requires a verifier result for the current commit
- [ ] transcript and retention policy; raw audio off by default
- [ ] disclosure and consent variations all behave correctly
- [ ] interruption, cross-talk, echo, reconnect, and duplicate audio handled
- [ ] a stale warm-up bundle is refreshed, or the staleness is stated aloud
- [ ] a malicious spoken request for a privileged tool becomes an ordinary Core decision request and cannot execute in the voice session
- [ ] operator takeover and emergency leave
- [ ] fake and implementation both pass the shared conformance suite

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
