# Development process — how work moves

**Audience:** every session, human or agent, before it touches anything.
**Related:** [implementation plan](implementation-plan.md) (what the packages are) ·
[board protocol](../../board/README.md) (how the board mechanically works) ·
[delivery plan](../04-delivery/delivery-plan.md) (what order risk is retired in)

This document is the map. The implementation plan says *what* to build, the board README says *how the
board works*, and this says **how work moves through the system** — every state a piece of work can be
in, every queue it can sit in, and who is allowed to move it.

> **The one rule.** Work never sits in a state nobody owns. If a piece of work cannot move, it must be
> in a queue with a named owner and a written reason. A card that is stuck but still looks claimable is
> the failure mode this whole process exists to prevent — it costs every agent that picks it up the
> same rediscovery, and it costs the human the signal that something needs them.

---

## 1. The unit of work

A **card** in `board/packages/<ID>-<name>.md`. One card = one package = one owner = one branch = one
worktree = one set of owned paths. Cards never share paths, which is why concurrent sessions merge to
`main` without conflicts.

Three kinds of card exist, and they behave differently:

| Kind | IDs | Deliverable | Ends when |
|---|---|---|---|
| **Foundation** | `W0` | The contracts, testkit, SDK and fakes everything imports | merged; unblocks Wave 1 |
| **Spike** | `SP1`–`SP5` | A **finding** (`FINDINGS.md`) with a kill-or-continue verdict; code is throwaway | a human reads it and clears a gate |
| **Service** | `S1`–`S20` | A production package behind an SDK interface, with its fake | exit criteria met and merged |

A spike is not a lesser card. Four of the five external gates cannot be cleared until a spike produces
the evidence, so spikes are frequently *the* critical path.

---

## 2. States

Five stored states, three derived. Derived states are recomputed from `origin/main` on every command, so
nothing has to be manually unblocked.

| State | Stored? | Meaning | Who moves it out |
|---|---|---|---|
| `todo` | stored | not started | any agent, via `next` |
| `claimed` | stored | a session owns it and its paths | that session |
| `blocked` | stored | **cannot progress until a human supplies something** | **human only** (`unblock`) |
| `in-review` | stored | criteria met, awaiting independent review | a *different* session (`review` → `approve`) |
| `done` | stored | merged to `main` | — |
| `available` | derived | `todo`, gate cleared, all `depends_on` are `done` | — |
| `waiting` | derived | `todo`, but a dependency is not `done` | resolves itself when the dependency merges |
| `gated` | derived | `todo`, but a **pre-declared** external gate is uncleared | **human only** (`clear-gate`) |

### `blocked` vs `gated` vs `waiting` — the distinction that matters

These three all mean "not claimable", and confusing them is how the board rots.

- **`waiting`** — blocked by *us*, on work already on the board. Resolves with no human action.
- **`gated`** — blocked by a decision we *knew about in advance* and wrote onto the card (`gate:`), like
  the meeting-platform choice. Needs a human decision.
- **`blocked`** — blocked by something *discovered during the work*: a credential, a licence token,
  administrator rights, an unpublished vendor price. Needs a human to **supply** something.

`blocked` was added because its absence caused real, measurable waste: **SP3 was claimed and released
five times in 56 minutes**, each session correctly concluding it needed a Ditto licence token that no
agent can obtain, and `next` — correctly ranking it first among Stage-0 work — handed it straight back
to the next agent. A release means "I am not working this, someone should"; `block` means "nobody can,
here is why". Use the right one.

---

## 3. The five queues

Every piece of work in this repository sits in exactly one of these. Each has an owner and a command.

| Queue | Holds | Owner | See it | Drain it |
|---|---|---|---|---|
| **Build** | `available` cards | any agent | `board.ps1 list` | `board.ps1 next` |
| **Review** | `in-review` cards | any agent *except the author* | `board.ps1 agents` | `review <ID>` → `approve <ID>` |
| **Blocked** | `blocked` cards | **human** | `board.ps1 next` report | `unblock <ID> -Note "..."` |
| **Gated** | `gated` cards | **human** | `board.ps1 next` report | `clear-gate <ID> -Note "..."` |
| **Requests** | contract change requests | W0 / S20 owner | `board.ps1 requests` | `resolve <fragment> -Note "..."` |

When an agent runs out of work, `next` prints all five, with reasons — that output *is* the human's
work list. Nothing else needs to be assembled by hand.

### The request queue needs draining, not just filling

A contract request is raised with `request <ID> -Note "..."` and **never blocks the raiser** — record
the assumption you are proceeding under in your card log and keep building. But filing was for a while
the only verb that existed, and the queue grew to 21 open requests with none resolved, including *four
independent filings of the same root-`tsconfig` problem* by S2, S4, S6 and S12.

Two things follow, and both are now mechanical rather than hoped-for:

- `request` warns when a similar request is already open, scored by word overlap, so the fifth session
  to hit a shared-file problem sees the four before it. It warns and proceeds — it never blocks a
  session mid-build to adjudicate a duplicate.
- `resolve` closes a request with the reason, and refuses an ambiguous fragment rather than guessing
  which of four it meant.

---

## 4. The agent loop

```powershell
.\board\scripts\board.ps1 next            # look at the board, rank, claim
git worktree add .worktrees/<ID> -b <branch>
# ... read ONLY the card and the docs it links ...
.\board\scripts\board.ps1 fake <ID>       # publish your fake early
.\board\scripts\board.ps1 check <ID> -Note "<criterion text>"
git rebase origin/main && pnpm run verify && git push origin HEAD:main
.\board\scripts\board.ps1 finish <ID>
git worktree remove .worktrees/<ID>
```

Then run `next` again. Do not stop between cards, and do not stop because the card you wanted was
taken — `next` handles contention for you by design.

**Three things an agent must do that are easy to skip:**

1. **Publish the fake before deepening the implementation.** A downstream session blocked on your fake
   is a worse outcome than your own package being a day late.
2. **Stay alive.** `check` and `fake` refresh your heartbeat as a side effect. If you go a long stretch
   without either — a long build, a deep debugging run — call `beat <ID>`, or another agent will
   legitimately reap your claim after the TTL.
3. **Block, don't release, when it is unbuildable.** See §2.

**When you are wrong, correct it.** `uncheck <ID> -Note "..."` un-ticks a criterion. The checkboxes are
what every other session trusts; a criterion ticked in error and only contradicted in a log comment is
worse than one never ticked.

---

## 5. The human loop

Everything an agent structurally cannot do. This is the whole list:

| Do this | When | Command |
|---|---|---|
| Supply a credential, licence, or privilege, then release the card | a card is `blocked` | `unblock <ID> -Note "..."` |
| Make a decision with legal, privacy, or procurement inputs | a card is `gated` | `clear-gate <ID> -Note "..."` |
| Read a spike's `FINDINGS.md` and rule kill-or-continue | a spike finishes | `clear-gate` on the cards it frees |
| Resolve or reject a contract change | `requests` is non-empty | `resolve <fragment> -Note "..."` |
| Approve a security-critical card | `S4`, `S5`, `S10` reach `in-review` | `approve <ID>` |

The last one is enforced, not requested: `approve` refuses when the approving session is the one that
built the card, and refuses again when the card has no recorded owner to be independent *of*.

---

## 6. Command map

| Phase | Command | Who |
|---|---|---|
| orient | `agents`, `list`, `status`, `requests` | anyone |
| take work | `next` (`-DryRun`, `-Wait`), `claim`, `review` | agent |
| signal progress | `check`, `uncheck`, `fake`, `beat` | owner |
| hand work back | `release` (ordinary), `block` (needs a human) | owner |
| finish | `finish`, `approve` | owner / independent reviewer |
| unstick | `unblock`, `clear-gate`, `resolve`, `reap` | human (`reap` is automatic in `next`) |
| escalate | `request` | agent, non-blocking |

---

## 7. What is actually enforced

Be precise about this: a rule nothing checks is a convention, and calling it enforcement is how it
quietly stops holding.

**Enforced by CI** (`.github/workflows/ci.yml`, on every push to `main`):

- typecheck across every referenced project, lint, import boundaries (`dependency-cruiser`)
- **path ownership** — every tracked file maps to exactly one owner (`check:ownership`)
- the full test suite, offline; and the fake-parity conformance report as a separate job

**Enforced by the board** (refuses the operation, exit 5):

- you cannot finish or release a card you do not own; `-Force` overrides the criteria count and nothing
  else, so it can never finish a card you never held
- you cannot approve a card you built
- you cannot finish with unticked criteria
- you cannot claim two cards, or take a review while holding a card
- a stale claim is returned only past a measured TTL, never on judgment

**Convention only — nothing stops you:**

- **the per-branch ownership diff does not run.** `check-path-ownership.mjs diff` is wired to
  `pull_request`, but this process pushes straight to `main`, so "this branch changed only what its
  card owns" is currently unchecked. The whole-tree ownership check still runs.
- ticking a criterion you did not meet
- reading design documents your card does not link
- rebasing on `main` daily

---

## 8. Where everything lives

| Path | What | Changes |
|---|---|---|
| `doc/` | the design package, tiered by the question it answers | rarely; see [tier map](../README.md) |
| `board/packages/` | one card per package — live delivery state | many times a day |
| `board/requests/` | contract change requests, one file each | on demand |
| `board/STATUS.md` | generated aggregate view | regenerated, **never hand-edited**, git-ignored |
| `packages/` | contracts, testkit, SDK + fakes — W0-owned, frozen after Wave 0 | via contract request only |
| `services/`, `windows/`, `eval/`, `integration/` | one directory per service card | by that card's owner only |
| `spikes/` | one directory per spike, each with its `FINDINGS.md` | by that spike's owner only |
| `.worktrees/` | one checkout per claimed card; git-ignored | per session |

The board is deliberately **not** in `doc/`. `doc/` holds documents whose value is that they are stable;
the board holds state whose value is that it is current. Mixing them means every claim is a
documentation change.
