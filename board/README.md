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

The board lives on `main`. A claim is a path-limited commit to `main`, pushed. If two sessions claim
the same card at once, the second `git push` is **rejected as non-fast-forward** — the remote is the
serialization point, and the loser finds out immediately instead of silently double-booking.

This is the same compare-and-set pattern that
[contracts §3](../doc/02-architecture/contracts-and-data.md#3-workflow-record-and-state-machine)
requires for workflow transitions. The board does not get to be less rigorous than the system it builds.

```powershell
# from the primary worktree
.\board\scripts\board.ps1 claim S07 -Session "kai-1"
```

Manual equivalent, if you would rather not use the script:

```bash
git pull --rebase origin main
# confirm  status: available  in board/packages/S07-*.md, then edit status/owner/claimed_at
git commit -m "board: claim S07 (kai-1)" -- board/packages/S07-connector-broker.md
git push origin main          # rejected? someone beat you. pull, re-read, pick another card.
```

**If your push is rejected:** pull, re-read the card. If it is now owned by someone else, that package
is gone — release nothing, claim a different card. Do not force-push the board, ever.

---

## 3. Session isolation — one worktree per session

Sessions must not share a working directory. Each claimed package gets its own git worktree:

```powershell
git worktree add ../otondev-S07 -b svc/S07-connectors
```

Code work happens in `../otondev-S07` on branch `svc/S07-connectors`. **Board commands are run from the
primary worktree** (`otondev/`, on `main`) — the script finds it automatically. This keeps shared board
state on one branch while code stays isolated per package.

When the package is done and merged: `git worktree remove ../otondev-S07`.

---

## 4. Card lifecycle

```text
blocked ──(gate clears)──> available ──claim──> claimed ──finish──> in-review ──> done
                               ^                    │
                               └──────release───────┘
```

| Status | Meaning |
|---|---|
| `blocked` | a gate outside this package's control is unmet; do not claim |
| `available` | claimable now, all prerequisites met |
| `claimed` | a session owns it; nobody else touches it or its paths |
| `in-review` | exit criteria all checked; awaiting review |
| `done` | merged to `main` |

Security-critical cards (**S04, S05, S10**) cannot go `in-review → done` on the owning session's own
judgment. They require the independent review named in implementation plan §7.

---

## 5. Rules while you hold a card

1. **Touch only the paths in your card's `Owns` field.** CI enforces this.
2. **Never edit another package's card**, including to note a dependency. Use your own card's log.
3. **Never hand-edit `STATUS.md`.** It is git-ignored and derived entirely from the cards, so it can
   never conflict — regenerate it instead: `.\board\scripts\board.ps1 status`.
4. **Shared files are off-limits** — root config, CI workflows, `packages/contracts`,
   `packages/testkit`, `docker-compose.dev.yml`. File a contract request instead (§6).
5. **Publish your fake early.** Tick `Fake published` on your card as soon as your fake is good enough
   to build against. A downstream session blocked on your fake is worse than your own package slipping.
6. **Rebase on `main` daily**, so contract updates reach you before they are expensive.

---

## 6. Contract requests

You will hit something the frozen contracts cannot express. Do not patch around it locally and do not
edit `packages/contracts` yourself.

```powershell
.\board\scripts\board.ps1 request S07 -Note "action.v2 needs a retry_after hint for rate-limited adapters"
```

That creates `requests/<date>-S07-<slug>.md`. The contract owner (the W0 / S20 session) resolves it.
**Do not block on it** — record the assumption you are proceeding under in your card's log and keep
building. Additive changes land quickly; renames and removals are scheduled.

---

## 7. Handoff and abandonment

A session that ends mid-package — context exhausted, interrupted, whatever — **must not leave the card
`claimed`**. Either:

- **Handing off:** append a log line stating exactly what is done, what is half-done, and the next
  concrete step. Leave status `claimed` and change `owner` to the incoming session.
- **Abandoning:** `.\board\scripts\board.ps1 release S07 -Note "why"`. Status returns to `available`,
  and the log keeps the history so the next owner is not starting blind.

A card `claimed` by a session that no longer exists is the main way this board rots. If you find one
that has not moved in a day, release it.

---

## 8. Starting a session

1. `git pull --rebase origin main`
2. `.\board\scripts\board.ps1 status` — see what is free
3. pick an `available` card, respecting the WIP limit below
4. `claim` it, then create your worktree
5. read the card's `Spec` link plus the documents it names — **not the whole design package**

## WIP limit

Implementation plan §6 puts the useful ceiling at **8–10 concurrent Wave-1 sessions**. Beyond that,
sessions spend more time queued on contract requests than building. Before W0 is `done`, the limit is
**one** — W0 is the serialization point and parallelizing it produces exactly the contract churn this
board exists to prevent.

## What does not belong here

Design discussion, decisions, and rationale. Those go to `doc/06-decisions/`. The board holds
**state**, not narrative — status, ownership, and a terse log. If a card's log is growing paragraphs,
the content belongs in a doc and the card should link to it.
