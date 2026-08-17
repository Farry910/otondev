# Runtime and desktop dependency requirements

**Parent:** [Agent Dev requirements](../../requirements.md)

## Windows VM and hypervisor

- **RDT-01:** The demo MUST use a Windows 11 VM created from a pinned, integrity-checked image.
- **RDT-02:** The image MUST define resolution, display scale, locale, timezone, user-session model,
  supported tools, patch level, and rollback snapshot.
- **RDT-03:** Agent desktop applications MUST run as an isolated non-administrator user.
- **RDT-04:** Hypervisor and host controls MUST remain inaccessible to general task processes.
- **RDT-05:** VM startup, shutdown, snapshot, restore, resource limits, and health MUST be automatable
  through a privileged supervisor boundary.
- **RDT-06:** VM loss MUST fence the active task and require workspace and external-state
  reconciliation after restore.

## Windows UI Automation

- **RDT-07:** Windows UI Automation is the primary semantic interface for supported native controls.
- **RDT-08:** The qualified support matrix MUST name application, version, control type, supported
  actions, known gaps, and fallback.
- **RDT-09:** Unsupported or ambiguous semantic targets MUST stop or require controlled coordinate
  fallback; they MUST NOT trigger speculative clicks.
- **RDT-10:** UI Automation failure MUST not bypass screen-sharing, credential, or policy controls.

## Browser

- **RDT-11:** The demo MUST qualify one supported browser version and automation/accessibility
  interface.
- **RDT-12:** Browser work MUST use an isolated profile with controlled extensions, downloads,
  clipboard, notifications, origins, and credential storage.
- **RDT-13:** Browser updates MUST pass the UI and connector conformance suite before rollout.
- **RDT-14:** Browser automation MUST preserve the same policy and evidence semantics as API access.

## IDE and developer tools

- **RDT-15:** IDE, CLI, test, database, monitoring, and cloud tools MUST use approved and pinned
  versions.
- **RDT-16:** Tool installation or upgrade requires separate administrative authority.
- **RDT-17:** Each supported tool MUST declare API, CLI, UI, and evidence-capture paths.
- **RDT-18:** Direct API or CLI is preferred for reliable private execution; visible UI is used for
  unsupported actions or human-facing demonstration.

## Consumers

- [Secure workspace and task executor](../services/secure-task-executor.md)
- [Presentation and UI simulation](../services/presentation-ui-simulation.md)
- [Connector and tool gateway](../services/connector-tool-gateway.md)
