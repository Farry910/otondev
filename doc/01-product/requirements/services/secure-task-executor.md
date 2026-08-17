# Secure workspace and task executor requirements

**Code:** EXE  
**Owns:** VM and workspace execution, processes, files, resource limits, and network boundary  
**Direct dependencies:** POL, CAP, CON, AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Execute engineering work in an isolated environment with the tools a developer needs.

## Requirements

- **EXE-01:** Each mutating task uses an isolated workspace, branch, or snapshot.
- **EXE-02:** Demo runs in a Windows 11 VM with fixed resolution, locale, scale, timezone, and pinned
  supported tools.
- **EXE-03:** Bound CPU, memory, storage, wall time, privilege, and child-process count.
- **EXE-04:** Network defaults to deny and uses task/tool destination allowlists.
- **EXE-05:** Filesystem access is restricted to authorized workspace and tool paths.
- **EXE-06:** Task processes receive no host, hypervisor, secrets-manager, or general cloud access.
- **EXE-07:** Capture commands, exits, relevant output, file changes, and process lineage with
  redaction.
- **EXE-08:** Support timeout, cancellation, checkpoint, cleanup, and quarantine.
- **EXE-09:** Tool installation uses approved, pinned packages under separate authority.
- **EXE-10:** Do not deliver from dirty or unknown state unless explicitly planned and evidenced.
- **EXE-11:** Desktop applications run in a user session isolated from privileged controls.

## Acceptance

Escape, network, exhaustion, stale-worker, cancellation, and credential tests pass.

## Related requirements

- [Runtime and desktop dependencies](../dependencies/runtime-desktop.md)
- [Capability and credential broker](./capability-credential-broker.md)
- [Verification and evidence](./verification-evidence.md)
