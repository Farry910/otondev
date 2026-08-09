# S20 — Integration and Vertical Slice

```yaml
id: S20
status: todo
owner: ""
claimed_at: ""
branch: svc/S20-integration
stage: 1
depends_on: W0
gate: none
gate_cleared: yes
fake: n/a
```

**Owns** — `integration/**`, the dev environment, and (with W0) the shared files
**Spec** — implementation plan §5 · S20 · [doc](../../doc/03-implementation/implementation-plan.md)
**Also owns** — contract-request resolution, `packages/contracts`, `packages/testkit`, root config, CI

> Runs **continuously** from the moment two Wave-1 packages land — it is not a final phase. Pair this
> card with S3, which is where seam defects surface first.

## Exit criteria

- [ ] dev environment wiring real implementations, replacing fakes one at a time
- [ ] the Stage-1 demo scenario as an executable test
- [ ] contract requests triaged and resolved; additive changes landed between waves
- [ ] the nine-step [first vertical-slice acceptance](../../doc/01-product/requirements.md#6-first-vertical-slice-acceptance) passes end to end with **no fakes in the path**
- [ ] crash before and during delivery both recover correctly
- [ ] operator capability revocation stops the system safely
- [ ] duplicate-event replay produces no duplicate PR or comment

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
