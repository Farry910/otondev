# Presence and real-time communication service requirements

**Code:** PRE  
**Owns:** meeting sessions, voice, turn-taking, disclosure, and transcript controls  
**Direct dependencies:** IDN, CGW, MEM, POL  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Let the agent participate safely and naturally in live voice meetings.

## Requirements

- **PRE-01:** Verify invitation, identity, participant scope, disclosure, and consent before joining.
- **PRE-02:** Demo SHOULD use OpenAI Realtime through CGW behind a provider-adaptable contract.
- **PRE-03:** Support listen, speak, mute, unmute, interrupt, cancel, leave, and takeover.
- **PRE-04:** Yield promptly on interruption and discard cancelled response audio.
- **PRE-05:** Apply participant access, consent, and retention to audio, transcript, and metadata.
- **PRE-06:** Scope warm memory to agenda, participants, active work, and evidence.
- **PRE-07:** Distinguish heard, verified, retrieved, and completed information.
- **PRE-08:** RTC loss degrades to mute, text, or leave without uncontrolled retry.
- **PRE-09:** Treat audio and transcript as untrusted ingress and apply secret controls.
- **PRE-10:** Delegate screen sharing to SIM only after separate preflight.

## Acceptance

Tests cover disclosure, interruption, mute, provider loss, scoped memory, and takeover.

## Related requirements

- [Model and memory dependencies](../dependencies/models-memory.md)
- [Team platform dependencies](../dependencies/team-platforms.md)
- [Presentation and UI simulation](./presentation-ui-simulation.md)
