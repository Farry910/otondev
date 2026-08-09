# SP5 — Presence platform and voice path: findings

> **This document does not make the decision.** `meeting-platform-decision` is a human call with
> legal, privacy, and procurement inputs an agent does not have. What follows is evidence and a
> recommendation, offered as input.

## The headline, stated plainly

**On none of the three candidate platforms is there a generally-available, vendor-sanctioned way
for a third-party AI agent to speak aloud in an ordinary meeting today.**

That is the finding, and it lands on the presence design's central premise — a disclosed AI
teammate that listens *and speaks*. Two of the three platforms will let an application receive
meeting audio and will not let it emit any. The third will do both, and its own documentation
tells you not to use it for this.

Delivery plan Stage 0 is explicit that a failed spike changes architecture before product work.
This is not a failed spike — the evidence is clear and the paths are real — but it does mean the
Stage-3 scope in the plan is larger or narrower than it looks, and the choice between those is
the human decision.

## Per-platform capability (exit criterion 1)

| | **Zoom** | **Microsoft Teams** | **Google Meet** |
|---|---|---|---|
| Bot may join as participant | **No** — prohibited | Yes (app-hosted media bot) | Media client, not a participant |
| Receive live audio | Yes, via RTMS | Yes, 50 frames/s | Yes (consume) |
| **Speak into the meeting** | **No documented path** | **Yes** — but see below | **No** — consume-only |
| Disclosed as AI | n/a (no participant) | Bot identity is visible | n/a |
| Availability | GA, credit-metered | GA, but partner-gated in practice | **Developer Preview** |
| Implementation constraint | app + RTMS scopes | **.NET/C# on Windows Server, Azure** | WebRTC, C++/TypeScript clients |

**Zoom.** The Meeting SDK — the only SDK that puts a client *in* a meeting — is closed to this
use case. Zoom's own documentation states: *"The Meeting SDK is reserved for human use cases and
does not support bots or AI notetakers."* and directs developers to *"use Zoom RTMS (Real-time
media streams)"* instead. RTMS is described as *"a data pipeline that gives your app access to
live audio, video, and transcript data"* and explicitly replaces the bot pattern: *"Instead of
having participant bots or automated clients in meetings, use RTMS apps to collect the media
data from the meeting."* Every RTMS page reviewed describes consumption only; **no outbound
audio path is documented**. RTMS consumes Zoom Developer Pack credits.

**Microsoft Teams.** Technically the strongest and rhetorically the weakest. The Real-time Media
Platform *"allows the bot to send and receive voice and video content frame by frame"*, and a bot
declares per modality *"whether it can send and receive media, receive only, or send only"* —
so bidirectional audio is genuinely supported. Audio is 16 kHz, 16-bit, 20 ms frames (320
samples, 640 bytes), 50 frames per second, with SILK and G.722 codecs; the bot can also identify
active and dominant speakers, which is directly useful for the design's turn-taking rules.

But the same page carries this: *"**Building AI agents for meetings?** Real-time Media bots are
not recommended for AI agent scenarios."* It names the intended scenarios as Cloud Video Interop,
Compliance Recording, and Contact Center integration, and says these *"are provided via managed
partners and in some cases certified by Microsoft."* It requires `Calls.AccessMedia.All`,
**C#/.NET on Windows Server**, and warns of *"significant infrastructure investment"* including
GPU-capable VMs.

Microsoft's suggested alternative for agents — Copilot Studio agents in meetings — appears to be
text/chat interaction in the meeting rather than autonomous participation in the audio stream.
*Treat that last point as unconfirmed:* it comes from search summaries of Microsoft Q&A threads,
not from a primary reference page, and it should be verified with Microsoft before it carries any
weight in the decision.

**Google Meet.** The Meet Media API is receive-only — the overview describes clients that
*"Consume video streams / Consume audio streams / Consume participant metadata"*, with no send
path. More restrictive still for a pilot: *"the Google Cloud project, OAuth principal, and all
participants in the conference must be enrolled in the Developer Preview Program."* Requiring
every human attendee to enrol makes this unusable for meetings with anyone outside the pilot,
independent of the missing speech capability.

## Consent and disclosure obligations (exit criterion 2)

The good news for the design: **on both Zoom and Teams the platform emits the notice itself.**
Disclosure of *recording* is not something the application has to implement, and not something it
can suppress. That removes a class of compliance risk the design was carrying, and it changes
what the `DISCLOSED` state in the meeting FSM is actually for.

**Zoom** prompts automatically and treats refusal as departure. Participants "are asked to
provide consent"; to refuse, a participant is instructed to *"Click **Leave** and then **Leave
Meeting** to opt out and exit the meeting."* The prompt also reaches people already present:
*"Participants already in the meeting with active audio and video when the host starts recording
will be prompted for consent."* Consequence for the design: **consent is binary and terminal.**
There is no "stay but do not record me" state to model — a participant who objects is gone, and
the meeting continues without them.

**Teams** enforces notification through policy rather than through the app. Recorded users
*"Be notified when recording is in progress"* and *"Be informed when policy and/or recorder error
is causing changes in calling behavior."* Notice is visual on Teams desktop/web/mobile/Phones/
Rooms and **audio** on SIP phones, Skype for Business, audio conferencing and PSTN callers — so a
dial-in attendee hears a spoken notice. Note the asymmetry the docs are explicit about:
*"users might not be able to disable the recording and might not have access to the recording."*
Teams' model is notification, not consent.

**Google Meet** was not established on this point and remains open — though it is moot for the
recommendation, since Meet is ruled out on capability grounds below.

**One constraint found here outweighs the rest.** The Teams compliance-recording path is fenced
by a certification program and an explicit scope statement: *"This solution is designed
specifically to turn on policy-based compliance recording with Teams. **Any other use of this
solution isn't supported.**"* and *"Microsoft only supports compliance recording solutions from
the listed, certified partners."* The documentation lists ~19 certified partners by name. Read
together with *"Real-time Media bots are not recommended for AI agent scenarios"*, the position
is consistent and unambiguous: **Microsoft supports in-meeting media bots for compliance
recording by certified partners, and this design is not that.** It also carries hard operational
requirements — the recorder bot *"must run on a Windows Virtual Machine and be deployed in
Azure"*, with specific inbound/outbound firewall IP ranges — plus per-user M365 A3/A5/E3/E5-class
licensing, and it is tested to 750 participants per meeting.

## Voice path (exit criterion 3) — blocked, with the floor measured

No voice-provider credential is available in this environment, so round-trip latency, barge-in,
and reconnect could not be measured. `src/voice-path.ts` implements all three and records each as
**skipped** with the reason rather than reporting an unmeasured number:

```powershell
$env:OPENAI_API_KEY = '<key>'
npm run voice
```

It defines the measurements the way the design needs them, which is not the way they are usually
quoted: round-trip is measured to the *first byte of output audio* (when sound starts, not when
the response completes), and barge-in is measured to the *last output audio byte actually
received* after an interrupt — how long the agent keeps talking over the human, not how quickly
it acknowledged.

What *was* measured, because it needs no credential — the network floor from this machine,
10 samples per target:

| endpoint | role | TCP connect p50 | TLS handshake p50 |
|---|---|---:|---:|
| `api.openai.com` | voice provider | 8.2 ms | 21.6 ms |
| `zoom.us` | Zoom control plane | 42.0 ms | 89.6 ms |
| `graph.microsoft.com` | Teams/Graph control plane | 30.5 ms | 89.0 ms |
| `meet.google.com` | Meet control plane | 48.5 ms | 123.9 ms |

Read this narrowly. It is the irreducible term of the latency budget — everything the provider
adds stacks on top — and it says the voice provider is *not* the network-distant component from
here; the meeting platforms are 4–6x further away. It is **not** end-to-end voice latency, and
these are handshake times from one machine on one network, not a p95 anyone should plan against.

## Data path (exit criterion 4)

| Path | What leaves the boundary | To whom | Region control |
|---|---|---|---|
| Zoom RTMS | live audio, video, screen share, transcript | Zoom → your endpoint | your endpoint's region is yours; Zoom's processing region is Zoom's |
| Teams app-hosted media | raw audio/video frames | Teams → **your Azure VM** | you choose the Azure region; media stays in infrastructure you run |
| Meet Media API | audio, video, participant metadata | Meet → your WebRTC client | your client's placement is yours |
| Voice provider | **meeting audio of every participant**, continuously | OpenAI (or chosen provider) | provider's stated regions only |

The row that matters is the last one. Whatever platform is chosen, the design streams *other
people's speech* to a third-party model provider for the whole meeting, not just the agent's own
turns — that is inherent to a realtime voice model doing turn detection. This is a materially
different disclosure and residency question from "the agent uses an LLM", and it is the part most
likely to require legal input. `memory-service.md` already treats raw audio retention as off by
default; that governs storage, not this transit.

Teams is the only candidate where the *meeting* media terminates on infrastructure the operator
owns. That is a real privacy advantage and it is worth weighing against Microsoft's discouragement.

## Cost per meeting-hour (exit criterion 5)

Voice provider only, computed by `src/cost.ts` from published rates. Assumptions stated in the
code and here: a 60-minute meeting, the agent listens for all 60 minutes (it cannot take turns on
audio it never heard), speaks 6 minutes across 12 turns. Published conversion: input audio is
1 token per 100 ms (600 tokens/min), output audio is 1 token per 50 ms (1,200 tokens/min).

| model | context billing | fresh input | re-sent context | output | **total / meeting-hour** |
|---|---|---:|---:|---:|---:|
| gpt-realtime | cached rate | $1.15 | $0.09 | $0.46 | **$1.70** |
| gpt-realtime | full rate | $1.15 | $6.91 | $0.46 | **$8.52** |
| gpt-realtime-mini | cached rate | $0.36 | $0.06 | $0.14 | **$0.57** |
| gpt-realtime-mini | full rate | $0.36 | $2.16 | $0.14 | **$2.66** |

**The spread is the finding, not the midpoint.** The Realtime API bills the accumulated
conversation as input on every response, so a one-hour meeting's cost is dominated by whether
that accumulated audio is billed at the cached rate ($0.40/1M) or the full rate ($32/1M) — a 5x
swing that no external arithmetic resolves. Any budget built on the low number should be
treated as unvalidated until measured on a real session.

Sensitivity to how much the agent talks is mild by comparison: 2 min/hour → $1.33, 30 min/hour →
$3.89 (gpt-realtime, cached). **Listening, not speaking, is the cost driver** — which is worth
knowing, because the instinct to control cost by making the agent quieter barely works.

Not included, and needed before any budget is real: Zoom Developer Pack credit consumption per
RTMS minute (published rates were not obtainable; the developer forum indicates per-minute credit
consumption and Zoom directs volume above 500 credits to sales), and for Teams the always-on
Azure Windows Server VM per concurrent meeting.

## Failure modes against the presence SLOs (exit criterion 6)

Relevant SLOs: presence recovery RTO **15 min**; emergency deny propagation **p95 < 10 s**;
`operations-and-evaluation.md` also tracks meeting join/speak/interruption/reconnect/share failure.

| Failure mode | Platform | Consequence for the SLO |
|---|---|---|
| No outbound audio path | Zoom, Meet | The agent cannot speak at all. This is not an SLO miss; it removes the `SPEAKING` state from the FSM. |
| Developer-Preview enrolment of every participant | Meet | Any external attendee blocks the conference outright — an availability cliff, not a degradation. |
| Media bot rejected / partner approval withdrawn | Teams | Total presence loss with no in-product recovery; RTO is a commercial timeline, not 15 min. |
| Windows Server media VM loss | Teams | Recovery is VM rebuild + rejoin; plausible within 15 min only with a warm standby per concurrent meeting. |
| Voice provider disconnect mid-turn | all | Design already mandates mute + bounded reconnect + text fallback; measurable only once `npm run voice` can run. |
| Barge-in slower than human patience | all | Not an SLO row today. The design says "stop output promptly"; **"promptly" is unquantified** and should get a threshold before S15 builds turn-taking against it. |
| Credit/quota exhaustion mid-meeting | Zoom | Media stream stops mid-conversation; needs a pre-join budget check in the existing preflight. |

## Which S15 exit criteria each candidate can satisfy (exit criterion 8)

S15's exit criteria: disclosure and consent variations; interruption, cross-talk, echo,
reconnect, duplicate audio; stale warm-up refreshed or declared stale; a malicious spoken request
for a privileged tool becomes an ordinary Core decision request; operator takeover and emergency
leave.

| S15 exit criterion | Zoom (RTMS) | Teams (media bot) | Meet (Media API) |
|---|---|---|---|
| disclosure and consent variations | partial — platform-level notice, no agent identity in the roster | **yes** — bot is a visible participant | partial, and preview-gated |
| interruption, cross-talk, echo, reconnect, duplicate audio | **no** — half of these need outbound audio | **yes** — send+receive, active/dominant speaker signals | **no** |
| stale warm-up refreshed or declared stale | yes — internal to the agent | yes | yes |
| malicious spoken request → Core decision request | yes — inbound-only path is enough | yes | yes |
| operator takeover and emergency leave | partial — nothing to take over audio-wise; "leave" is stopping a stream | **yes** — real join/leave and mute | partial |

Only Teams can satisfy the full set. Zoom and Meet can satisfy the listening and safety halves
of S15 but not the speech half, on any timeline the vendor currently documents.

## Recommendation — input to the decision, not the decision

1. **If a speaking agent is non-negotiable for Stage 3, the only candidate is Teams — and it is
   a commercial question before it is an engineering one.** The technical path exists and is well
   specified: `Calls.AccessMedia.All`, C#/.NET on a Windows Server VM in Azure, 16 kHz PCM frames
   at 50 fps, with active/dominant-speaker signals that suit the design's turn-taking rules. Some
   of that cost the project is paying anyway, since S16 and S17 already commit to a Windows/.NET
   presence component.

   But the gating constraint is not infrastructure. Microsoft supports in-meeting media bots for
   **policy-based compliance recording by certified partners**, states that *"any other use of
   this solution isn't supported"*, and separately says real-time media bots are *"not
   recommended for AI agent scenarios"*. Building on it anyway means running unsupported, on a
   platform capability that could be narrowed without notice, with no support path when it
   breaks. That is a risk the project can choose to take; it is not one an engineering decision
   should absorb silently, which is why it belongs in this recommendation rather than in a
   backlog ticket.

2. **Otherwise, split presence into listen-and-contribute now, speak later.** All three platforms
   support receiving audio; all three support the agent contributing in meeting chat. That
   version of presence satisfies most of S15's safety criteria — grounded responses, malicious
   spoken requests becoming Core decision requests, transcript and consent handling — and defers
   exactly the capability that is blocked. It is also honest to participants in a way a synthetic
   voice is not.

3. **Do not select Google Meet for the pilot.** Receive-only plus mandatory Developer Preview
   enrolment for every participant is disqualifying for meetings with anyone outside the pilot,
   regardless of the other trade-offs.

4. **Before committing either way, resolve two things this spike could not.** Run
   `npm run voice` with a provider key to get real round-trip, barge-in, and reconnect numbers —
   and set a threshold for "promptly" in the interruption rule, because S15 will otherwise be
   built against an untestable word. Then confirm the per-platform consent obligations against
   primary documentation, since disclosure is a state in the FSM rather than a nicety.

A third pattern exists and was not evaluated: meeting-bot vendors that abstract joining and
speaking across platforms. Zoom's own developer blog points at one for RTMS infrastructure. This
would change the data path substantially — meeting audio would traverse a further third party —
and deserves its own diligence rather than a guess here.

## Sources

Primary documentation, quoted above:

- [Zoom — Meeting SDK for Linux](https://developers.zoom.us/docs/meeting-sdk/linux/) (bots not supported)
- [Zoom — Realtime Media Streams](https://developers.zoom.us/docs/rtms/) · [RTMS for meetings](https://developers.zoom.us/docs/rtms/meetings/) · [getting started](https://developers.zoom.us/docs/rtms/meetings/getting-started/)
- [Microsoft — Real-time Media Calls and Meetings for Bots](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)
- [Microsoft — Requirements for application-hosted media bots](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots)
- [Google — Meet Media API overview](https://developers.google.com/workspace/meet/media-api/guides/overview)
- [Zoom — Providing consent to be recorded](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059819)
- [Microsoft — Teams compliance recording (third-party)](https://learn.microsoft.com/en-us/microsoftteams/teams-recording-compliance) (notification methods, certification program, support boundaries, bot hosting requirements)
- [OpenAI — Realtime cost management](https://developers.openai.com/api/docs/guides/realtime-costs) (audio token conversion) · [Pricing](https://developers.openai.com/api/docs/pricing)

Consulted but **not** confirmed against a primary reference page — flagged in the text:

- [Microsoft Copilot Studio — add agents to Teams meetings](https://learn.microsoft.com/en-us/power-platform/release-plan/2024wave1/microsoft-copilot-studio/add-copilots-teams-meetings)
- [Zoom — Developer pricing](https://zoom.us/pricing/developer) (RTMS credit consumption per minute not published)
- Google Meet consent/recording-disclosure obligations: not established.
