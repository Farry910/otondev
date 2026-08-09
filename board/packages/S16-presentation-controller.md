# S16 — Presentation Controller

```yaml
id: S16
status: todo
owner: ""
claimed_at: ""
branch: svc/S16-companion
stage: 3
depends_on: 
gate: windows-spike
gate_cleared: no
fake: no
```

**Owns** — `windows/companion/**`
**Spec** — implementation plan §5 · S16 · [doc](../../doc/03-implementation/implementation-plan.md)
**Read also** — [presentation controller](../../doc/02-architecture/components/simulation-service.md)
**Separate process** — least-privilege interactive Windows session, **not administrator**
**Toolchain** — .NET, UIA/FlaUI, Playwright (independent of the TypeScript control plane)

> **Gated on delivery-plan Stage-0 spike 1.**

## Exit criteria

- [ ] the verb and annotation vocabulary from the component doc
- [ ] adapter hierarchy: product API → Playwright → UIA/FlaUI → OCR → coordinates, each with postconditions
- [ ] safe-share preflight: notifications closed, exact window verified, masks applied, commit confirmed, rehearsal done
- [ ] non-interactive overlay that never modifies the underlying application
- [ ] local emergency stop that works with the network and control plane down
- [ ] app upgrade, scaling, localization, and target-window change all handled
- [ ] a notification or secret popup during share **stops the share first**, then recovers
- [ ] a stale commit or wrong environment is caught by preflight
- [ ] locator ambiguity or postcondition failure falls back to the approved static artifact
- [ ] overlay alignment survives scroll and resize

## Log

<!-- newest last · `YYYY-MM-DD HH:MM | session | note` -->
