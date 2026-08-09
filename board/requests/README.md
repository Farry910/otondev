# Contract change requests

One file per request. Never edit someone else's request; never edit `packages/contracts` directly
while you hold a package card.

Create with:

```powershell
.\board\scripts\board.ps1 request <CARD-ID> -Note "what you need and why"
```

Naming: `<YYYY-MM-DD>-<card-id>-<slug>.md`. One new file per request means these never conflict.

Resolution is owned by the W0 / S20 session. Additive changes (new optional field, new enum member)
land quickly. Renames and removals require a version bump and are scheduled between waves.

**Requesting is not blocking.** Record the assumption you are proceeding under in your card's log and
keep building.
