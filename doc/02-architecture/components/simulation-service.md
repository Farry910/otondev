# Presentation Controller — safe UI walkthroughs

**Status:** proposed v2; retains “Simulation Service” as a product alias  
**Related:** [Presence](presence-service.md) · [Secure Box](../secure-box-and-supervision.md) ·
[Security](../security-and-credentials.md)

## Responsibilities

- Prepare and navigate the agent's Windows presentation desktop for meetings.
- Share only the intended safe window/surface.
- Execute semantic UI steps with postcondition checks and recoverable fallbacks.
- Render explanatory annotations such as circles, arrows, highlights, and selections.
- Produce diagnostic evidence without leaking screen contents into general logs.

It is not the normal coding executor. Solo work uses isolated CLI/API/browser task adapters. Meeting
join controls are part of presentation lifecycle even though the original idea described simulation as
meeting-only.

## Architecture

The controller is a least-privilege interactive-session companion launched at user logon. A separate
non-interactive supervisor monitors it and communicates over mutually authenticated, ACL-restricted
local IPC. The companion exposes high-level verbs; it does not expose a raw remote shell.

```yaml
verb: focus_target
target: {app: browser, semantic_id: pr_diff, commit: abc123}
preconditions: [meeting_joined, share_not_started]
postconditions: [window_title_matches, commit_badge_matches]
timeout_ms: 8000
fallback: approved_static_diff
```

## Adapter hierarchy

Use the most semantic, observable method available:

1. meeting/product API for state when supported;
2. browser adapter/Playwright for DOM-owned surfaces;
3. Windows UI Automation/FlaUI for native controls;
4. OCR/vision only as an explicitly lower-confidence fallback;
5. coordinates only for a fixed, version-pinned demo and always with visual postcondition.

Playwright is not a transparent fallback for UIA: they operate at different layers and may observe
different state. Each target application needs a tested adapter and semantic locator version.

## Safe-share preflight

Before sharing:

- enter a dedicated desktop/browser profile with no unrelated accounts or history;
- close notifications, password managers, chat popups, terminals with secrets, and unrelated apps;
- verify the exact window/monitor share target and disable whole-desktop sharing by default;
- confirm the intended repository, PR, branch, commit, environment, and test artifact;
- run on-screen sensitive-content detection and configured masks;
- confirm overlay and emergency stop work;
- rehearse the bounded walkthrough without transmitting; and
- acquire the exclusive presentation lock.

If any check fails, use a pre-rendered approved artifact or do not share.

## Verb and annotation vocabulary

Navigation verbs: `open_target`, `focus_target`, `activate`, `type_public_text`, `scroll_to`,
`select_semantic_range`, `wait_for`, `capture_region`, `start_share`, `stop_share`.

Annotation verbs: `point`, `circle`, `highlight`, `draw_arrow`, `label`, `select_rows`, and `clear`.
Annotations SHOULD use a non-interactive overlay that never changes the underlying application. Every
annotation is anchored to a semantic element/region and disappears on window/layout mismatch.

Natural cursor paths and typing cadence are optional presentation polish. They must not reduce
reliability, slow emergency stop, or imply a human is controlling the system.

## Walkthrough plan

A walkthrough is generated from immutable evidence, then preflighted:

```text
Step 1: show PR at head SHA -> assert SHA visible
Step 2: show changed function -> highlight exact diff hunk
Step 3: state why -> cite ticket/decision
Step 4: show independent verifier artifact -> assert run/commit match
Step 5: state limitations -> show skipped checks if any
```

Presence narrates only after each postcondition. The controller can fall back to approved static HTML,
images, or text artifacts when a live app is unstable.

## Evidence capture boundary

Task evidence is created by the worker/verifier from commands, logs, CI, and commit metadata. The
controller may capture a cropped visual artifact only when the definition of done calls for visual
evidence. Captures are reviewed/scanned, encrypted, access-controlled, and short-lived. Continuous
whole-desktop recording is forbidden by default.

## Security controls

- No production credentials or cloud admin console session on the presence desktop.
- Clipboard starts empty; cross-boundary clipboard/file transfer is disabled or brokered.
- Text typing forbids secret-class fields and limits destinations.
- Browser downloads/uploads are disabled unless a typed plan step authorizes them.
- Every command is policy-bound, sequenced, timed out, and auditable.
- Emergency stop works locally even if the control plane/network fails.
- Unexpected window/focus/notification causes share stop before recovery.

## Resolution and platform roadmap

Fixed resolution is acceptable for an initial platform test, but AutomationIds are not made stable by
resolution. Layout changes, scaling, app versions, localization, virtual desktops, and accessibility
trees all require testing. Cross-OS support needs separate adapters; it is not achieved by keeping the
verb API alone.

## Required tests

- app/browser upgrades, scaling, localization, and target-window changes;
- notification/secret popup while sharing;
- stale PR/commit and wrong environment;
- semantic locator ambiguity and postcondition failure;
- operator takeover/emergency stop offline;
- overlay alignment after scroll/resize;
- fallback artifact behavior and screen-capture retention.

## Open decisions

- First meeting/browser/IDE surfaces and pinned versions.
- Overlay implementation and sensitive-screen detector.
- Whether a dedicated virtual display or separate Windows VM is used per agent/concurrent meeting.
