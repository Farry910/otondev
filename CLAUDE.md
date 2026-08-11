# otondev — autonomous implementation sessions

Design package for **Agent Dev**. The design is finished and authoritative; you are here to implement it.

## When the user says "start implementation"

Run the loop below. **Do not ask which task to work on, and do not ask permission between steps.** The
board decides what you work on. Keep going until the board says there is nothing left.

```powershell
.\board\scripts\board.ps1 next
```

`next` reads the live board — who is working on what — then ranks every available card and claims the
best one that does not collide with work in flight. **A collision is never a reason to stop.** If the
card it wanted is taken mid-pick it takes the next one; if all of them go, it looks for review work,
then returns claims whose owner has gone silent, and only then reports that it is blocked. You do not
need to handle any of that; just read the exit code.

| Code | Meaning | What you do |
|---|---|---|
| 0 | a card was claimed for you | work it (below) |
| 3 | nothing available | print why (the command explains), then **stop** |
| 4 | you already hold a card | finish or release it first |
| 5 | a precondition was refused | read the one-line reason and adjust; this is normal |
| 1 | the board itself is broken | stop and report it |

If you would rather idle than stop when the board is momentarily full, `next -Wait` parks and claims
the moment anything frees up. Use it when you know a peer is about to land W0.

### Working a card

1. `git worktree add .worktrees/<ID> -b <branch>` — the command prints the exact line. Work **only**
   inside that worktree. Worktrees live under `.worktrees/` so the parent directory is not
   littered with sibling checkouts; it is git-ignored and excluded from ESLint.
2. Read `board/packages/<ID>-*.md` and **only** the documents it links. Do not read the whole design
   package; the card names what matters.
3. Implement. Stay strictly inside the card's `Owns` paths.
4. Consume every peer through `packages/sdk` interfaces backed by fakes. **Never import another
   service's source.**
5. Publish your fake as soon as it is usable: `board.ps1 fake <ID>` — a downstream session blocked on
   your fake is worse than your own package slipping.
6. Tick each exit criterion as you genuinely meet it:
   `board.ps1 check <ID> -Note "<text from the criterion>"`
   `check` and `fake` also mark you alive. If you go a long stretch without either — a deep debugging
   run, a long build — run `board.ps1 beat <ID>` so another agent does not reap your claim.
7. When all criteria are ticked and tests pass offline with peers faked:
   - `git rebase origin/main`
   - run the tests again
   - `git push origin HEAD:main`
   - `board.ps1 finish <ID>`
8. `git worktree remove .worktrees/<ID>`, then run `next` again and repeat.

### When a card cannot be finished

Two different situations, two different commands. Getting this wrong wastes every agent after you.

- **You are stopping, but the work is doable** — out of context, changed priorities:
  `board.ps1 release <ID> -Note "what is done, what is next"`. It goes back in the queue.
- **Nobody can do it without a human** — a credential, licence token, administrator rights, a price
  nobody publishes: `board.ps1 block <ID> -Note "exactly what a human must supply"`. `next` stops
  offering it and reports it to the human.

**Never `release` a card that is truly blocked.** `next` ranks Stage-0 work first, so a released spike
comes straight back to the next agent, which then rediscovers the same blocker. SP3 went round that
loop five times in 56 minutes before `block` existed.

If you ticked a criterion you had not actually met, fix it: `board.ps1 uncheck <ID> -Note "<text>"`.

### Landing work on `main`

Packages own disjoint paths, so merging to `main` should never conflict. **If the rebase does
conflict, stop and report it** — it means a path-ownership rule was violated, and that is a real defect
to surface, not something to resolve by picking a side.

Dependencies are derived from `main`, so a card only unblocks its dependents once its work is actually
merged. Finishing without pushing stalls every session waiting on you.

## Hard rules

- **Never pick a card by hand.** Always `next`. Hand-claiming defeats the conflict-avoidance.
- **Never touch another package's paths, card, or branch.**
- **Never edit shared files** — root config, CI, `packages/contracts`, `packages/testkit`,
  `docker-compose.dev.yml`. Raise `board.ps1 request <ID> -Note "..."` and keep building under a stated
  assumption; do not block on it.
- **Never force-push**, and never force-push the board. A rejected push means another session landed
  first; re-read and retry.
- **Never take a card off another session by judgment.** "The worktree looks untouched" is not
  evidence — that exact reasoning has already stolen a live claim here. Liveness is measured: only
  `board.ps1 reap` may return a claim, and only after the owner has been silent past the TTL.
- **Never tick a criterion you have not actually met**, and never `-Force` a `finish` to get past a
  failing test. The checkboxes are what other sessions trust.
- **S4, S5, S10 do not self-approve.** `finish` stops them at `in-review` for independent review.

## Stop and ask the user when

- `next` returns 3 and everything left is `gated` or `blocked`. Those need a human. Report the exact
  list `next` printed — for a gate, say whether the spike that produces its evidence (`SP1`–`SP5`) is
  done, in flight, or unclaimed; for a blocked card, say what it needs supplied. If a producing spike
  is still unclaimed, that is work, not a gate: run `next` again rather than stopping.
- A rebase onto `main` conflicts.
- The card's spec contradicts the design docs, or the work cannot be done as specified.

Otherwise: keep working. Do not check in between cards. In particular, do **not** stop because another
agent holds the card you wanted — that is the one case `next` is built to handle for you.

## Where things are

| Path | What |
|---|---|
| `doc/` | the design package — see `doc/README.md` for the tier map |
| `doc/03-implementation/development-process.md` | **how work moves** — states, the five queues, who owns each, what is enforced |
| `doc/03-implementation/implementation-plan.md` | package decomposition, §5 has every card's full brief |
| `board/` | live delivery state; `board/README.md` is the full protocol |
| `board/packages/` | one card per package — the unit of work |
