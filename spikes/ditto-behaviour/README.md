# SP3 — Ditto behaviour spike

Throwaway code whose deliverable is [`FINDINGS.md`](FINDINGS.md). Read that first.

## Running

```powershell
npm install
npm run probe          # single peer: records, provenance, tombstones, DQL capability sweep
npm run sync           # gating check: can two peers sync on this machine at all?
npm run sync-suite     # criteria 2-6 — needs DITTO_OFFLINE_LICENSE_TOKEN, skips cleanly without
npm run report         # render the recorded evidence as markdown
npm run typecheck
```

`probe` and `sync` need no credentials. `sync-suite` needs an offline-only licence token from
[portal.ditto.live](https://portal.ditto.live):

```powershell
$env:DITTO_OFFLINE_LICENSE_TOKEN = '<token>'
```

Without it, `sync-suite` records every criterion as **skipped** with the observed activation
error rather than passing or failing them.

## Layout

| File | What |
|---|---|
| `src/runtime.ts` | loads the SDK safely — normalises `NO_COLOR`, quiets trace logging |
| `src/peer.ts` | a peer wired for a controlled localhost-only two-peer experiment |
| `src/evidence.ts` | JSONL evidence log and the `check()` used by every criterion |
| `src/probe.ts` | single-peer behaviour and the `MemoryStore` capability sweep |
| `src/sync-capability.ts` | the gating question, run on its own |
| `src/sync.ts` | the two-peer suite for exit criteria 2–6 and the decisive case for 7 |
| `src/report.ts` | renders `evidence/*.jsonl` to markdown |

## Two things worth knowing before changing anything

**Discovery is off on purpose.** Bluetooth, AWDL, Wi-Fi Aware, mDNS and multicast are all
disabled and peers are introduced by explicit `127.0.0.1:<port>`. Re-enabling discovery would
put a synthetic memory database on whatever network the developer is attached to, and would make
"the peers did not converge" ambiguous between a CRDT result and a slow mDNS lookup.

**A skipped check is not a pass.** `check()` records `pass`, `fail` or `skipped`, and the report
prints skips explicitly. Anything that silently omits untested criteria makes the gate decision
on false evidence.
