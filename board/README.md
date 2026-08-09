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
git worktree add ../otondev-S7 -b svc/S7-connectors
```

The session works entirely inside `../otondev-S7` on branch `svc/S7-connectors` and runs board commands
**from that same directory**. No session ever needs `main` checked out, and none needs to return to the
primary worktree for anything.

When the package is merged: `git worktree remove ../otondev-S7`.

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

External gates (`isolation-spike`, `ditto-spike`, `windows-spike`, `meeting-platform-decision`) can
only be cleared by a human: `board.ps1 clear-gate S10 -Note "spike passed"`.

Security-critical cards (**S4, S5, S10**) cannot go `in-review → done` on the owning session's own
judgment. They require the independent review named in implementation plan §7.

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

A card `claimed` by a session that no longer exists is the main way this board rots. If you find one
that has not moved in a day, release it.

---

## 8. Starting a session

Sessions do **not** pick their own work. One command does select-and-claim atomically:

```powershell
.\board\scripts\board.ps1 next
```

It prefers the earliest stage, then the card that unblocks the most others, with a random tiebreak so
simultaneous sessions spread across candidates instead of all colliding on the same one. Exit codes:
`0` claimed, `3` nothing available (it prints why), `4` you already hold a card.

The autonomous session loop is in [`CLAUDE.md`](../CLAUDE.md), which every session loads on startup.

| Command | Effect |
|---|---|
| `next [-Session <name>]` | **pick + claim** the best available card, atomically |
| `status` / `list` | fetch and show the board (`status` also regenerates `STATUS.md`) |
| `check <ID> -Note "<text>"` | tick the first unchecked exit criterion matching `<text>` |
| `fake <ID>` | mark your fake published so downstream sessions can depend on it |
| `finish <ID>` | → `done`, or `in-review` for S4/S5/S10; refuses while criteria are unticked |
| `approve <ID>` | `in-review` → `done`, for the security-critical cards only |
| `release <ID> -Note "<why>"` | → `todo`, keeping the log history |
| `clear-gate <ID> -Note "<why>"` | human clears an external gate (spike result, platform choice) |
| `claim <ID>` | manual override; prefer `next` |
| `request <ID> -Note "<need>"` | raise a contract change request |

## WIP limit

Implementation plan §6 puts the useful ceiling at **8–10 concurrent Wave-1 sessions**. Beyond that,
sessions spend more time queued on contract requests than building. Before W0 is `done`, the limit is
**one** — W0 is the serialization point and parallelizing it produces exactly the contract churn this
board exists to prevent.

## What does not belong here

Design discussion, decisions, and rationale. Those go to `doc/06-decisions/`. The board holds
**state**, not narrative — status, ownership, and a terse log. If a card's log is growing paragraphs,
the content belongs in a doc and the card should link to it.
