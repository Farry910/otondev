# SP2 — sandbox isolation spike

Answers delivery-plan Stage-0 spike 2. **The deliverable is [FINDINGS.md](FINDINGS.md)**; this
directory is the evidence behind it and is throwaway code by design.

## Run it

```bash
node run-spike.mjs                # everything, ~90s including the in-sandbox test suite
node run-spike.mjs --skip-tests   # containment and quotas only, ~30s
node run-spike.mjs --keep         # leave containers and networks for inspection
```

Needs a running Docker daemon and network access to build the images. Writes
`results/sp2-run.json`. Exit status is non-zero if any check fails.

It briefly binds host ports 8200 and 8899 as vault and LAN stand-ins, creates containers and
networks prefixed `sp2-`, and removes them all unless `--keep` is passed.

## What is here

| Path | What |
|---|---|
| `run-spike.mjs` | the driver: builds images, runs every phase, writes results |
| `worker/Dockerfile` | the workspace image — digest-pinned, non-root, no tools beyond the toolchain |
| `escape/escape-suite.mjs` | runs *inside* a workspace; probes everything it must not reach |
| `proxy/allowlist-proxy.mjs` | deny-by-default egress with an explicit host allow-list and a log of every decision |
| `results/sp2-run.json` | the last run |

## The one thing to keep if this code is thrown away

Every negative result is paired with a positive control. "The workspace could not reach the
vault" means nothing on its own — a typo in a hostname produces the same output as perfect
isolation. So the same suite runs a second time with isolation deliberately removed, and has
to reach the vault. The peer-workspace check works the same way: two workspaces on a shared
network must reach each other before "they cannot reach each other on separate networks" is
worth writing down.

Three bugs in this harness were caught by that discipline, and each one had produced a
confident wrong answer first:

- counting async `spawn` calls reported 200 successful forks against a limit of 32, because
  none of them had forked yet;
- counting `/proc` from inside the workspace reported nothing, because once the pid limit
  bites the shell cannot fork `ls` either;
- `pnpm test | tail` reported **exit 0 over a failing test suite**, because a pipeline's status
  is the last command's.

The third is the one to remember. A spike harness that reports green over red is worse than no
harness, and it looked completely normal.
