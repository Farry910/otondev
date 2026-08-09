# SP4 — Connector semantics spike

```yaml
id: SP4
status: todo
owner: ""
claimed_at: ""
heartbeat: ""
reviewer: ""
branch: spike/SP4-connector-semantics
stage: 0
depends_on: 
gate: none
gate_cleared: yes
clears_gate: none
fake: n/a
owns: spikes/connector-semantics/**
```

**Owns** — `spikes/connector-semantics/**`
**Spec** — [delivery plan](../../doc/04-delivery/delivery-plan.md#stage-0--decisions-and-spikes-roughly-12-weeks) Stage-0 spike 3
**Read also** — [contracts §7](../../doc/02-architecture/contracts-and-data.md) action and idempotency, [task engine](../../doc/02-architecture/components/task-engine.md)
**Informs** — S1 (dedupe) and S7 (connector broker); clears no gate

> **Kill-or-continue.** This spike answers whether one real provider can honour the
> `agentdev.action.v2` lifecycle — in particular whether `outcome_unknown` is actually recoverable
> against a live API. If it is not, S7's exit criteria are unachievable as written and the contract
> changes before S7 starts, not after.

## Exit criteria

- [ ] one real provider (GitHub, Jira, or Slack) driven end to end through `prepared → sent → succeeded`
- [ ] an idempotency key prevents a duplicate PR, comment, or transition on replay of the same event
- [ ] an ambiguous timeout is forced, and `lookup` / `reconcile` determines present-or-absent afterwards
- [ ] automatic retry is **refused** while the outcome is unknown, and the reconcile path is what resolves it
- [ ] a duplicate inbound webhook produces exactly one effect
- [ ] compensation behaviour is characterised for the action classes the provider supports, and the ones where it is impossible are named
- [ ] recorded HTTP fixtures are captured so S7 can build offline against them
- [ ] `spikes/connector-semantics/FINDINGS.md` records a **kill-or-continue verdict** and every contract gap found, in the form S7 would need to raise as a contract request

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
