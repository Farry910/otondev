# SP5 — Presence platform and voice path spike

```yaml
id: SP5
status: blocked
owner: 
claimed_at: 
heartbeat: 
reviewer: ""
branch: spike/SP5-presence-platform
stage: 0
depends_on: 
gate: none
gate_cleared: yes
clears_gate: meeting-platform-decision
fake: n/a
owns: spikes/presence-platform/**
blocked_on: needs OPENAI_API_KEY for the voice-path harness (npm run voice), and Zoom RTMS credit rates that are not published. 2 of 8 criteria unreachable without both.
```

**Owns** — `spikes/presence-platform/**`
**Spec** — [delivery plan](../../doc/04-delivery/delivery-plan.md#stage-0--decisions-and-spikes-roughly-12-weeks) Stage-0 spike 5
**Read also** — [presence service](../../doc/02-architecture/components/presence-service.md), [external constraints](../../doc/06-decisions/external-constraints.md)
**Unblocks** — S15 (once a human makes the platform choice and clears `meeting-platform-decision`)

> **This spike does not make the decision.** `meeting-platform-decision` is a human call with legal,
> privacy, and procurement inputs an agent does not have. The spike's job is to make that decision
> *cheap to make*: measured evidence per candidate, and a clear statement of what each choice costs.

## Exit criteria

- [x] for each candidate platform: whether a bot can join, be disclosed as an AI, receive audio, and speak — with the API evidence
- [x] per platform, the consent and recording-disclosure obligations the platform itself imposes
- [ ] a candidate voice path measured for round-trip latency, barge-in / interruption handling, and behaviour on reconnect
- [x] the data path is documented: what audio or transcript leaves the boundary, to which provider, in which region
- [ ] cost per meeting-hour estimated for each candidate, with the assumptions stated
- [x] the failure modes that would violate the presence SLOs are named per platform
- [x] `spikes/presence-platform/FINDINGS.md` presents a **comparison and a recommendation**, explicitly marked as input to a human decision, not as the decision
- [x] the finding states which S15 exit criteria each candidate can satisfy and which it cannot

## Handing the result back

A human makes the platform choice, then:

```powershell
.\board\scripts\board.ps1 clear-gate S15 -Note "platform: <choice>, per SP5"
```

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 14:32 | agent-sess-a860aca9 | claimed
- 2026-08-09 14:45 | agent-sess-a860aca9 | released - Work landed on main (2ae66f9). 6 of 8 criteria met. FINDINGS.md: no candidate platform offers a generally-available sanctioned way for a third-party AI agent to SPEAK in a meeting -- Zoom bans bots in the Meeting SDK and RTMS documents no outbound audio, Meet Media API is consume-only and needs every participant enrolled in Developer Preview, and Teams can do it but restricts in-meeting media bots to certified compliance-recording partners. Two criteria remain and both need credentials this environment lacks: the voice path needs OPENAI_API_KEY (harness is written and typechecks, skips cleanly -- run npm run voice), and per-candidate cost needs Zoom RTMS credit rates which are not published. Releasing rather than force-finishing: the unchecked boxes are accurate.
- 2026-08-09 15:07 | agent-sess-ec39663a | claimed
- 2026-08-09 15:08 | agent-sess-ec39663a | released - Confirmed still blocked: no OPENAI_API_KEY in this environment, and the per-candidate cost criterion needs Zoom RTMS credit rates that are not published. Both remaining criteria are the same ones agent-sess-a860aca9 recorded at 14:45; nothing has changed, and no code change would help. Like SP3, this card is re-offered first by 'next' after every release -- it needs a gate or a credential, not another claim.
- 2026-08-10 22:34 | agent-bbf05b75 | blocked - needs OPENAI_API_KEY for the voice-path harness (npm run voice), and Zoom RTMS credit rates that are not published. 2 of 8 criteria unreachable without both.
