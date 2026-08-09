# SP5 — Presence platform and voice path spike

The deliverable is [`FINDINGS.md`](FINDINGS.md). Read that first; this file is only how to
reproduce the measured parts.

```powershell
npm install
npm run netfloor     # network floor to the voice provider and the three meeting platforms
npm run cost         # cost per meeting-hour from published rates, with the assumptions varied
npm run voice        # round-trip, barge-in, reconnect — needs OPENAI_API_KEY, skips cleanly without
npm run typecheck
```

`netfloor` and `cost` need no credentials. `voice` needs one:

```powershell
$env:OPENAI_API_KEY = '<key>'
npm run voice
```

Without it, every measurement is recorded as **skipped** with the reason. It never reports a
number it did not measure — most of this spike is other people's published figures, so the few
measured numbers have to be trustworthy or they are worse than nothing.

## What each measurement means

`netfloor` measures DNS, TCP connect and TLS handshake to the real endpoints. That is the
irreducible term of the voice latency budget, **not** end-to-end voice latency. TLS is reported
separately from TCP because reconnect behaves differently: session resumption skips most of the
handshake, so a reconnect budget built on full-handshake numbers is pessimistic and one built on
TCP alone is optimistic.

`voice` defines its measurements the way the presence design needs them rather than the way they
are usually quoted:

- **round-trip** — commit of input audio to the *first byte of output audio*, because a
  conversation feels responsive when sound starts, not when the response completes;
- **barge-in** — interrupt to the *last output audio byte actually received*, because what
  matters is how long the agent keeps talking over a human, not how fast it acknowledged;
- **reconnect** — socket close to a session that could carry a turn again, which is the term
  that feeds the presence recovery SLO.

`cost` prints a range, not a number. Realtime pricing re-bills accumulated conversation audio on
every response, and whether that lands at the cached or full rate swings a meeting-hour by ~5x.
