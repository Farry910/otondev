# Presentation and UI simulation service requirements

**Code:** SIM  
**Owns:** screen control, pointing and selection gestures, overlays, and visual evidence capture  
**Direct dependencies:** PRE, EXE, POL, AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Control and explain through a real desktop in ways visible to collaborators.

## Requirements

- **SIM-01:** Prefer Windows UI Automation or browser accessibility targets over coordinates.
- **SIM-02:** Coordinate fallback requires validated fixed resolution, scale, layout, and window.
- **SIM-03:** Support pointing, circling, highlighting, range and multi-row selection, arrows,
  scrolling, clicking, typing, and screenshots on supported applications.
- **SIM-04:** Explanation overlays are visually distinct and do not mutate applications.
- **SIM-05:** Mutating UI actions require authorized intent, target, and expected result.
- **SIM-06:** Before action or sharing, confirm foreground app, window, element, and sensitive-content
  state.
- **SIM-07:** Hide password fields, tokens, private notifications, and unrelated windows or stop share.
- **SIM-08:** Emergency stop yields immediately to human input or operator takeover.
- **SIM-09:** Demo mode uses understandable motion; execution uses the most reliable authorized path.
- **SIM-10:** Correlate UI actions and evidence with meeting and task IDs.
- **SIM-11:** Maintain a tested application, version, and control support matrix.

## Acceptance

The fixed Windows image can demonstrate work, annotate and select data, block a seeded secret window,
and stop on takeover.

## Related requirements

- [Runtime and desktop dependencies](../dependencies/runtime-desktop.md)
- [Presence and real-time communication](./presence-realtime.md)
- [Secure workspace and task executor](./secure-task-executor.md)
