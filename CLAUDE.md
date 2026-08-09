# otondev — autonomous implementation sessions

Design package for **Agent Dev**. The design is finished and authoritative; you are here to implement it.

## When the user says "start implementation"

Run the loop below. **Do not ask which task to work on, and do not ask permission between steps.** The
board decides what you work on. Keep going until the board says there is nothing left.

```powershell
.\board\scripts\board.ps1 next
```

`next` atomically picks the best available card and claims it for you. Exit codes:

| Code | Meaning | What you do |
|---|---|---|
| 0 | a card was claimed for you | work it (below) |
| 3 | nothing available | print why (the command explains), then **stop** |
| 4 | you already hold a card | finish or release it first |

### Working a card

1. `git worktree add ../otondev-<ID> -b <branch>` — the command prints the exact line. Work **only**
   inside that worktree.
2. Read `board/packages/<ID>-*.md` and **only** the documents it links. Do not read the whole design
   package; the card names what matters.
3. Implement. Stay strictly inside the card's `Owns` paths.
4. Consume every peer through `packages/sdk` interfaces backed by fakes. **Never import another
   service's source.**
5. Publish your fake as soon as it is usable: `board.ps1 fake <ID>` — a downstream session blocked on
   your fake is worse than your own package slipping.
6. Tick each exit criterion as you genuinely meet it:
   `board.ps1 check <ID> -Note "<text from the criterion>"`
7. When all criteria are ticked and tests pass offline with peers faked:
   - `git rebase origin/main`
   - run the tests again
   - `git push origin HEAD:main`
   - `board.ps1 finish <ID>`
8. `git worktree remove ../otondev-<ID>`, then run `next` again and repeat.

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
- **Never tick a criterion you have not actually met**, and never `-Force` a `finish` to get past a
  failing test. The checkboxes are what other sessions trust.
- **S4, S5, S10 do not self-approve.** `finish` stops them at `in-review` for independent review.

## Stop and ask the user when

- `next` returns 3 and the remaining work is `gated` — those need a human decision (a Stage-0 spike
  result, or the meeting-platform choice). Say which gate and stop.
- A rebase onto `main` conflicts.
- The card's spec contradicts the design docs, or the work cannot be done as specified.

Otherwise: keep working. Do not check in between cards.

## Where things are

| Path | What |
|---|---|
| `doc/` | the design package — see `doc/README.md` for the tier map |
| `doc/03-implementation/implementation-plan.md` | package decomposition, §5 has every card's full brief |
| `board/` | live delivery state; `board/README.md` is the full protocol |
| `board/packages/` | one card per package — the unit of work |
