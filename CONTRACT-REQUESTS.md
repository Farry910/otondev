# Contract requests

`packages/contracts` is frozen after Wave 0 (implementation-plan §6 rule 3). You will hit
something it cannot express. Do not patch around it locally and do not edit the package.

```powershell
.\board\scripts\board.ps1 request S7 -Note "action.v2 needs a retry_after hint for rate-limited adapters"
```

That writes `board/requests/<date>-S7-<slug>.md`, which the W0 / S20 owner resolves. **Do not
block on it.** Record the assumption you are building under in your card's log and keep going —
additive changes (a new optional field, a new enum member) land quickly; renames and removals
need a version bump and are scheduled.

This file is the running index of requests that changed the contracts, so a session reading a
schema can see why it looks the way it does without archaeology.

| Date | Card | Request | Resolution |
|---|---|---|---|
| — | — | *none yet* | — |
