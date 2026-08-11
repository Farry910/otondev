# Delivery board

Live coordination state for concurrent implementation sessions. This is **not** documentation — it
changes many times a day and is deliberately kept out of `doc/`, whose tiers hold stable documents.

**Spec for every card:** [implementation plan](../doc/03-implementation/implementation-plan.md) §5.
**Order risk is retired in:** [delivery plan](../doc/04-delivery/delivery-plan.md).

---

## 1. Why the board is many files

One shared `BOARD.md` that every session edits is the single most reliable way to create merge
conflicts in this repository. So the board applies the same rule the implementation plan applies to
code: **one card per package, one owner, one file.** Two sessions working on different packages never
touch the same file, so their board commits merge cleanly and always.

| Thing | Where it lives | Who writes it |
|---|---|---|
| package state | `packages/<ID>-<name>.md` | the session that owns that card |
| aggregate view | `STATUS.md` | **generated and git-ignored** — regenerate, never hand-edit |
| contract change request | `requests/<date>-<id>-<slug>.md` | the requesting session, one new file |
| handoff note | the `## Log` section of the card | the outgoing session |

---

## 2. Claiming is a compare-and-set against `origin/main`

Board state lives on `origin/main` and is **never read from or written to a checked-out branch**:

- **reads** — `git show origin/main:<card>`, so no working tree is touched at all;
- **writes** — a commit built with plumbing against a temporary index, pushed straight to `main`.

`origin/main` is the single serialization point. A rejected push means another session landed first, so
the command re-reads fresh state, re-applies its change, and retries with exponential backoff and
jitter. If the precondition no longer holds — the card is now owned by someone else — you get a clean
refusal rather than a silent overwrite.

```powershell
.\board\scripts\board.ps1 claim S7 -Session "kai-1"
# S7 is 'claimed' (owner: rin-1). Pick another card.
```

This is the same compare-and-set pattern that
[contracts §3](../doc/02-architecture/contracts-and-data.md#3-workflow-record-and-state-machine)
requires for workflow transitions. The board does not get to be less rigorous than the system it builds.

Because writes never check anything out, **the board does not care where you run it from**: any
directory, any branch, any worktree, dirty tree or clean. Your working tree is never modified, and
there is no shared index, so sessions cannot collide on `index.lock`.

> Verified under load: 12 concurrent writes from 3 sessions all landed as 12 separate commits with no
> lost updates, and 3 sessions claiming one card simultaneously produced exactly one winner and two
> clean refusals.

**Never force-push the board.** A rejected push is the mechanism working, not a problem to override.

---

## 3. Session isolation — one worktree per session

Sessions must not share a working directory — that is the one place they could still collide. Each
claimed package gets its own git worktree:

```powershell
git worktree add .worktrees/S7 -b svc/S7-connectors
```

The session works entirely inside `.worktrees/S7` on branch `svc/S7-connectors` and runs board commands
**from that same directory**. No session ever needs `main` checked out, and none needs to return to the
primary worktree for anything.

When the package is merged: `git worktree remove .worktrees/S7`.

Worktrees live *under* the repository rather than beside it, so the parent directory does not
accumulate one sibling checkout per card. `.worktrees/` is git-ignored and excluded from ESLint —
both are required, because a nested worktree is a checkout of a different branch and every tool
that walks the tree would otherwise read it as part of this one. A session that finishes without
removing its worktree leaves a stale entry; `git worktree prune` clears it.

---

## 4. Card lifecycle

A card **stores** only four states. Everything else is **derived**, so nobody has to remember to
unblock anything:

```text
todo ──claim──> claimed ──finish──> done                    (ordinary cards)
  ^               │       ──finish──> in-review ──approve──> done   (S4, S5, S10)
  └───release─────┘
```

| Stored `status` | Meaning |
|---|---|
| `todo` | not started |
| `claimed` | a session owns it; nobody else touches it or its paths |
| `blocked` | cannot progress until a **human supplies something**; `next` will not offer it |
| `in-review` | exit criteria met, awaiting independent review |
| `done` | merged to `main` |

| Derived state | How it is computed |
|---|---|
| `available` | `todo`, gate cleared, and every `depends_on` card is `done` |
| `waiting` | `todo`, but a `depends_on` card is not `done` yet |
| `gated` | `todo`, but an external gate is uncleared — needs a human decision |

Because availability is derived from `origin/main`, **finishing a card automatically makes its
dependents claimable**. Finishing W0 turns 14 cards from `waiting` to `available` with no human step.
The corollary: a card only unblocks its dependents once its work is actually merged to `main`.

Besides `status`, a card carries `owner`, `claimed_at`, `heartbeat` (last sign of life — see §7),
`reviewer` (who holds the independent review), and, on the spike cards, `clears_gate` (which external
gate this card's finding lets a human clear). All are optional: a card missing a field is read with a
safe default, so cards written by an older copy of the script still work.

External gates (`isolation-spike`, `ditto-spike`, `windows-spike`, `meeting-platform-decision`) can
only be cleared by a human: `board.ps1 clear-gate S10 -Note "spike passed"`. A human clearing a gate
should not have to invent the evidence, so each gate has a card that **produces** it — `clears_gate`
wires SP1→S16/S17, SP2→S10, SP3→S14, SP5→S15 — and the board reports that link whenever it tells you
something is gated.

Security-critical cards (**S4, S5, S10**) cannot go `in-review → done` on the owning session's own
judgment. They require the independent review named in implementation plan §7, and this is enforced
rather than requested: `approve` refuses when the approving session is the one that built the card, and
refuses again when the card has no recorded owner to be independent *of*.

---

## 5. Rules while you hold a card

1. **Touch only the paths in your card's `Owns` field.** CI enforces this.
2. **Never edit another package's card**, including to note a dependency. Use your own card's log.
3. **Never hand-edit `STATUS.md`.** It is git-ignored and derived entirely from the cards, so it can
   never conflict — regenerate it instead: `.\board\scripts\board.ps1 status`.
4. **Shared files are off-limits** — root config, CI workflows, `packages/contracts`,
   `packages/testkit`, `docker-compose.dev.yml`. File a contract request instead (§6).
5. **Publish your fake early** — `board.ps1 fake S7` — as soon as it is good enough to build against.
   A downstream session blocked on your fake is worse than your own package slipping.
6. **Tick exit criteria as you meet them** — `board.ps1 check S7 -Note "ambiguous timeout"` ticks the
   first unchecked criterion matching that text. `finish` counts what is left and refuses while any
   remain, so a card's checkboxes are the honest progress signal other sessions read.
7. **Rebase your branch on `main` daily**, so contract updates reach you before they are expensive.

---

## 6. Contract requests

You will hit something the frozen contracts cannot express. Do not patch around it locally and do not
edit `packages/contracts` yourself.

```powershell
.\board\scripts\board.ps1 request S7 -Note "action.v2 needs a retry_after hint for rate-limited adapters"
```

That creates `requests/<date>-S7-<slug>.md`. The contract owner (the W0 / S20 session) resolves it.
**Do not block on it** — record the assumption you are proceeding under in your card's log and keep
building. Additive changes land quickly; renames and removals are scheduled.

---

## 7. Handoff and abandonment

A session that ends mid-package — context exhausted, interrupted, whatever — **must not leave the card
`claimed`**. Either:

- **Handing off:** append a log line stating exactly what is done, what is half-done, and the next
  concrete step. Leave status `claimed` and change `owner` to the incoming session.
- **Abandoning:** `.\board\scripts\board.ps1 release S7 -Note "why"`. Status returns to `available`,
  and the log keeps the history so the next owner is not starting blind.

### Never judge another session's liveness by eye

A card `claimed` by a session that no longer exists is the main way this board rots — but *guessing*
which sessions are alive is worse than the rot. It has already gone wrong here: on 2026-08-09 a session
released a live W0 claim because the worktree "looked untouched", and the owner had to reclaim it.

So liveness is **measured, not judged**. An owner marks itself alive with `beat`, and `check` / `fake`
do it implicitly, so an actively working session refreshes its own `heartbeat` as a side effect of
working. Only a claim with no sign of life for `-StaleMinutes` (default **120**) can be returned, and
only by `reap`:

```powershell
.\board\scripts\board.ps1 reap                      # returns claims silent for 120+ min
.\board\scripts\board.ps1 reap -StaleMinutes 240    # be more patient
```

`release` refuses to touch a card you do not own. If you really are that session, name yourself
(`-Session <owner>`); if the card looks abandoned, `reap` it — and if it is not stale enough to reap,
**it is not abandoned enough to take**. `next` reaps automatically, but only after it has exhausted
every other option.

---

## 8. Starting a session

Sessions do **not** pick their own work. One command reads the live board, ranks everything, and
select-and-claims atomically:

```powershell
.\board\scripts\board.ps1 next
```

### A collision is never a reason to stop

`next` is a ladder, not a single attempt. It gives up only when it can *prove* nothing is left:

1. **Look at the board first.** It prints who is working on what before it chooses anything.
2. **Already holding a card?** That is the work — it says so and exits `4`. One card per session.
3. **Claim down the ranked list.** If the best card is taken mid-pick, it takes the next one, and the
   next. Losing a race costs one retry, never the session.
4. **No build work? Take review work.** A card sitting in `in-review` is real, claimable work for a
   *different* agent, and S4/S5/S10 cannot reach `done` without it.
5. **Still nothing? Reap.** Claims silent past the TTL are returned to the pool (§7) and the ladder
   restarts.
6. **Only then, stop** — printing exactly what is in flight, what waits on which dependency, and which
   gates need a human, naming the card that produces each gate.

Add `-Wait` and it does not even stop there: it parks, re-reads the board every `-WaitSeconds`, and
claims the moment anything frees up. That is the difference between an agent that idles until W0 lands
and one that exits.

Exit codes: `0` got work · `3` nothing available, reason printed · `4` you already hold a card ·
`5` refused a precondition (someone else owns it, criteria unmet) · `1` the board is broken.
`5` and `3` are normal answers; only `1` means something is wrong.

### How it chooses

Ranked, in order — `next -DryRun` prints the whole ranking and claims nothing:

| Signal | Why |
|---|---|
| earliest **stage** | Stage 0 spikes and the foundation retire risk before Wave-1 build work |
| most cards **freed** | transitive over both dependency *and* gate edges, so the card that unblocks the most agents goes first |
| least **path overlap** | prefers work far from what is already in flight, so two agents rarely meet |
| unpublished **fake** with dependents | a fake others are waiting on is worth starting sooner |
| random | simultaneous sessions spread out instead of colliding on one card |

### Commands

| Command | Effect |
|---|---|
| `next [-Wait] [-DryRun]` | **pick + claim** the best non-conflicting card; `-Wait` parks instead of stopping |
| `agents` | who is working on what, how long, and how recently they were seen |
| `status` / `list` | fetch and show the board (`status` also regenerates `STATUS.md`) |
| `beat <ID>` | "still alive" — protects your claim from `reap` |
| `block <ID> -Note "<what a human must supply>"` | → `blocked`; `next` stops offering it |
| `unblock <ID> -Note "<what changed>"` | → `todo`; **human only** |
| `check <ID> -Note "<text>"` | tick the first unchecked exit criterion containing `<text>` (literal match) |
| `uncheck <ID> -Note "<text>"` | un-tick a criterion ticked in error |
| `requests` | the open contract-request queue |
| `resolve <fragment> -Note "<what changed>"` | close a contract request |
| `fake <ID>` | mark your fake published so downstream sessions can depend on it |
| `finish <ID>` | → `done`, or `in-review` for S4/S5/S10; refuses while criteria are unticked |
| `review <ID>` | take the independent review on an `in-review` card |
| `approve <ID>` | `in-review` → `done`; **structurally refuses** the session that built it |
| `release <ID> -Note "<why>"` | → `todo`; refuses if you are not the owner |
| `reap [-StaleMinutes N]` | return claims with no sign of life past the TTL |
| `clear-gate <ID> -Note "<why>"` | human clears an external gate (spike result, platform choice) |
| `claim <ID>` | manual override; prefer `next` |
| `request <ID> -Note "<need>"` | raise a contract change request |

The autonomous session loop is in [`CLAUDE.md`](../CLAUDE.md), which every session loads on startup.

## Stage 0 is parallel; Wave 1 is not

The `SP*` cards are the five kill-or-continue spikes from
[delivery plan Stage 0](../doc/04-delivery/delivery-plan.md#stage-0--decisions-and-spikes-roughly-12-weeks).
They exist on the board because four of the five external gates cannot be cleared until someone
*produces the finding* — so a spike is not a detour from the critical path, it **is** the critical path,
and `next` names the producing card whenever it reports a gated blocker.

They are also what keeps a second agent working while W0 is held: they own `spikes/**`, depend on
nothing, and overlap no other package's paths. Six agents can work Stage 0 at once.

A spike's deliverable is the **finding**, not the code. Throwaway implementation is expected; a
verdict of "this cannot work as designed" is a successful spike, and delivery plan Stage 0 is explicit
that a failed spike changes architecture before product work.

## WIP limit

Implementation plan §6 puts the useful ceiling at **8–10 concurrent Wave-1 sessions**. Beyond that,
sessions spend more time queued on contract requests than building. Before W0 is `done`, **one** session
builds W0 — it is the serialization point and parallelizing it produces exactly the contract churn this
board exists to prevent. That limit applies to W0 itself, not to the board: the spikes are deliberately
outside it, because they touch no shared path and answer questions W0 cannot answer.

## What does not belong here

Design discussion, decisions, and rationale. Those go to `doc/06-decisions/`. The board holds
**state**, not narrative — status, ownership, and a terse log. If a card's log is growing paragraphs,
the content belongs in a doc and the card should link to it.
