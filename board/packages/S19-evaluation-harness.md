# S19 — Evaluation and Conformance Harness

```yaml
id: S19
status: claimed
owner: agent-sess-ec39663a
claimed_at: 2026-08-09 18:09
branch: svc/S19-eval
stage: 1
depends_on: W0
gate: none
gate_cleared: yes
fake: n/a
heartbeat: 2026-08-09 18:09
```

**Owns** — `eval/**`
**Spec** — implementation plan §5 · S19 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [operations §5](../../doc/05-operations/operations-and-evaluation.md) evaluation layers

> **Start this in Wave 1, not later.** Every other card's exit gate depends on it. Building it last
> means retrofitting evidence for work already declared done.

## Exit criteria

- [ ] the conformance runner and fake-parity driver from W0 made real
- [ ] fault-injection suite: process, worker, host, network, provider, token, storage, bad rollout
- [ ] adversarial corpus: direct, indirect, encoded, and multimodal prompt injection
- [ ] canary exfiltration attempts through model, URL, DNS, tool parameter, artifact, log, screenshot, audio
- [ ] task-quality benchmark harness with frozen tasks and hidden tests
- [ ] cost and latency regression by pinned model/prompt version
- [ ] every card's exit criteria are expressible in the harness and run in CI
- [ ] the harness **fails the build** on a safety regression rather than reporting it

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
- 2026-08-09 18:09 | agent-sess-ec39663a | claimed
