# Presence Service — disclosed live collaboration

**Status:** proposed v2  
**Related:** [Presentation](simulation-service.md) · [Memory](memory-service.md) ·
[Secure Box](secure-box-and-supervision.md) · [Security](security-and-credentials.md)

## Responsibilities

- Join only authorized meetings as a clearly identified AI teammate.
- Listen, speak, mute, interrupt, leave, and hand control to an operator safely.
- Ground speech in current source-linked memory and live function results.
- Coordinate a sanitized, narrated walkthrough with the Presentation Controller.
- Apply consent, transcript, audio, retention, and participant privacy policy.

## Meeting lifecycle

```text
SCHEDULED -> PREFLIGHT -> READY -> JOINING -> DISCLOSED -> LISTENING <-> SPEAKING
                                                   |             <-> PRESENTING
                                                   -> LEAVING -> ENDED -> INGESTED
```

Any state can enter `MUTED`, `OPERATOR_TAKEOVER`, `POLICY_BLOCKED`, or `FAILED`. The service defaults
to mute and no sharing after uncertainty, reconnect, focus loss, or policy failure.

## Authorization and consent preflight

Before joining:

- verify calendar source, tenant, meeting URL allow-list, organizer, invited agent, and time window;
- resolve policy for joining, transcription, recording, attendee names, and memory ingestion;
- build a short-lived warm-up bundle with sources and expiry;
- check audio devices, provider health, budget, latency, mute state, and operator contact;
- verify the agent's display name/profile discloses automation; and
- select the platform adapter and tested client version.

At join, the agent announces it is an AI teammate and whether it is transcribing/retaining content,
unless equivalent disclosure is already unambiguously shown by the platform. If required consent is
missing or withdrawn, recording/transcription stops and affected content is not ingested.

## Voice pipeline

```text
meeting output -> virtual/managed audio input -> voice provider adapter
meeting input  <- virtual/managed audio output <- provider response
                                      |
                                      +-> typed read-only functions through Core
```

OpenAI Realtime is a candidate because it supports realtime audio/text and function calling, but the
service uses a provider adapter. Provider sessions get only the minimum warm-up context and typed
read-only functions by default. Mutating actions requested in speech become normal Core decision
requests and cannot execute inside the voice session.

The implementation must handle echo cancellation, device routing, network jitter, provider timeout,
reconnect, and rate/cost limits. A text/caption fallback is preferable to speaking stale or fabricated
content.

## Turn-taking

Turn-taking combines platform events/captions when available, local voice activity detection,
address/name detection, explicit hand raise/agenda state, and interruption detection. Rules:

- default to listening;
- do not respond to overheard speech outside the meeting channel;
- stop output promptly on interruption or operator mute;
- avoid repeating a point after reconnect;
- do not speak for another agent or person;
- state uncertainty and offer a sourced follow-up rather than improvise.

Simple name detection alone is insufficient for cross-talk, names in examples, accents, and multiple
agents.

## Grounded responses

Every factual work update uses the warm-up bundle or a typed live lookup. “The tests pass” requires a
verifier result linked to the current commit. If the current source differs from the warm-up bundle,
the service refreshes or says the information is stale. A conversation summary distinguishes what was
said, what was decided, and what remains proposed.

## Synchronized walkthrough

Presence acquires exclusive microphone and presentation-desktop locks, then sends a preflighted
walkthrough plan to the Presentation Controller. Each narration segment waits for the corresponding UI
postcondition. Failure causes a truthful pause (“I couldn’t open that view”) rather than continuing a
script over the wrong screen.

Background work may continue in a different task sandbox, but it cannot modify the commit/branch being
presented and cannot publish chat/audio messages competing with the meeting.

## Transcript and memory

- Raw audio retention is off by default.
- Transcript creation and retention are policy/consent-controlled.
- Speaker attribution is probabilistic unless the platform provides identity; uncertainty is retained.
- Commands spoken by participants are untrusted requests, not authorization.
- Meeting decisions require explicit extraction, source timestamps, owner, status, and optional human
  confirmation before becoming shared memory.
- Withdrawal/deletion propagates through transcript, summary, embeddings, and warm caches.

## Failure behavior

| Failure | Safe response |
|---|---|
| provider disconnect | mute, attempt bounded reconnect, show text/operator notice |
| companion/session loss | stop share/audio, leave if possible, page operator |
| warm-up expired | refresh; otherwise state that facts may be stale |
| UI target mismatch | pause presentation and fall back to static approved artifact |
| unexpected sensitive window/notification | stop share immediately, record privacy incident metadata |
| consent withdrawal | stop capture/ingestion and apply retention workflow |
| emergency stop | mute, stop share, leave, revoke session capability |

## Required tests

- disclosure and consent variations;
- interruption, cross-talk, echo, reconnect, and duplicate audio;
- stale/wrong-commit warm-up facts;
- malicious spoken prompt requesting a privileged tool;
- unexpected notification/secret on screen;
- operator takeover and emergency leave;
- transcript speaker uncertainty, correction, and deletion;
- supported platform/client-version matrix.

## Open decisions

- First meeting platform and whether native SDK/events are available.
- Recording/transcription/retention policy by jurisdiction/customer.
- Voice provider latency, price, residency, and reliability thresholds.
