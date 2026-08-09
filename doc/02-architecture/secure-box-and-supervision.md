# Secure Box and supervision — isolation and recovery

**Status:** proposed v2  
**Related:** [Security](security-and-credentials.md) · [Agent Core](components/agent-core.md) ·
[Presentation](components/simulation-service.md) · [Operations](../05-operations/operations-and-evaluation.md)

## Reframing the Secure Box

The original idea makes the Secure Box one always-running Windows 11 VM containing identity, models,
tools, memory, screen, and credentials. That is a useful demo metaphor but a weak security and
reliability boundary. V2 defines the Secure Box as the **per-agent trust zone and resource namespace**:

- stable logical identity/home;
- isolated disposable task workers;
- dedicated or reserved presence desktop;
- scoped memory namespace and budgets; and
- access to a separate policy/capability broker.

The components can be colocated for local development, but production trust boundaries remain explicit.

## Runtime zones

| Zone | Persistence | Trust | Contains | Does not contain |
|---|---|---|---|---|
| control plane | durable/HA | high | workflow, policy, identity, broker, audit metadata | repo execution, desktop UI |
| task worker | disposable per attempt | untrusted | one workspace, toolchain, task capability | durable secrets, other repos, browser profile |
| verifier worker | disposable | untrusted/independent | immutable diff/commit and checks | executor narrative, publish capability |
| presence desktop | persistent/rebuildable | medium | meeting client, safe browser/profile, companion | prod credentials, untrusted builds |
| memory/data plane | durable | high by service | Ditto records, operational DB, artifacts by ACL | arbitrary task processes |

Per-agent namespaces prevent cross-agent access, but identity does not require a heavy VM for every
background task. A small pilot may reserve one Windows VM per agent for presence while using separate
workers for builds.

## Windows session architecture

Modern Windows services are non-interactive and run in session 0. The design therefore uses:

```text
Windows Service (LocalService/custom service account)
  - health, update, IPC endpoint, session discovery, emergency containment
             | authenticated ACLed named pipe / local RPC
Interactive Companion (dedicated least-privilege user session)
  - meeting client, UIA/Playwright, virtual audio, annotation overlay, local stop
```

The service launches/monitors the companion in the intended interactive user session using supported
Windows session mechanisms. The elevated service never exposes a privileged UI or accepts unauthenticated
IPC. The companion is not administrator.

Auto-logon is acceptable only in an isolated controlled demo with documented physical/host access and
minimal credentials. Pilot/production should use managed session startup, host encryption, screen and
console controls, patching, endpoint protection, and a tested reconnect strategy.

## Task worker lifecycle

1. Verify signed worker image/config and allocate tenant/agent/workflow namespace.
2. Mint workload identity and receive lease/fencing token.
3. Clone/materialize only the allowed repo/base SHA.
4. Apply mounts, executable, network, resource, and time policy.
5. Run commands; stream bounded telemetry; store large output as artifacts.
6. Submit evidence through authenticated channel.
7. Lose publish capability on cancellation/lease expiry.
8. Destroy worker and securely expire task tokens; retain only policy-approved artifacts.

Use a VM boundary where running untrusted native code or nested containers makes a container boundary
insufficient. Windows Sandbox can help for disposable Windows application testing, but its default
network, clipboard, audio, and persistence properties must be explicitly configured and it is not the
same as the persistent presence desktop.

## Supervision hierarchy

- host/cluster manager ensures node/VM placement and restarts;
- service manager supervises each control-plane service;
- workflow engine detects missing worker leases and performs fenced recovery;
- Windows service supervises the interactive companion;
- provider/connector circuit breakers prevent restart storms;
- rollout controller uses health gates, version pinning, canary, and rollback.

A child heartbeat only proves the heartbeat loop ran. Health checks must cover dependency readiness,
queue progress, lease freshness, storage writes, model/connector health, interactive session, audio,
and screen-share readiness as appropriate.

## Recovery semantics

| Failure | Recovery |
|---|---|
| Core process | restart; rebuild from operational workflow state |
| task worker | wait/fence lease; reconcile external actions; create new attempt |
| presence companion | stop share/audio if possible; restart in same session; re-preflight |
| presence VM/host | notify/leave; rebuild from image; no meeting continuity guarantee |
| operational DB | failover/restore per RPO; block mutations until authority is consistent |
| Ditto memory | continue without nonessential memory or use last authorized cache; no policy fallback |
| provider outage | same-policy fallback or explicit degraded/block state |
| credential broker | fail closed for mutations; active short-lived capabilities expire/revoke |

VM snapshots are not a substitute for database backup and may restore stale tokens, software, or task
state. Restore uses immutable images plus durable configuration/state where possible.

## Provisioning and fleet management

- immutable/versioned base images and configuration;
- per-agent identity/policy/memory namespace applied after clone/provision;
- no baked credentials or mutable secrets in images;
- automated patch/image rebuild and drift detection;
- inventory of agent, host/VM, worker image, companion version, toolchain, and policy versions;
- capacity scheduler for CPU/GPU/RAM/desktop/meeting slots and provider budgets;
- quarantine and reimage workflow for suspected compromise.

## Availability targets

The pilot SLOs in [operations-and-evaluation.md](../05-operations/operations-and-evaluation.md) replace “never die.”
Targets cover control availability, event durability, workflow recovery, presence recovery, stop
propagation, and duplicate side effects. They are validated with process, worker, host, network,
provider, token, storage, and bad-rollout fault injection.

## Required tests

- verify Windows service cannot directly rely on interactive desktop and companion IPC ACLs hold;
- user logoff/lock/reconnect, VM reboot, focus and display changes;
- worker attempts host socket, vault, metadata, LAN, other workspace, and presence access;
- stale worker tries to publish after fencing;
- snapshot/image restore does not revive stale authority;
- patch/canary rollback and restart storm;
- host loss, DB failover, Ditto unavailable, provider outage, and broker outage;
- emergency stop with network/control-plane unavailable.

## Open decisions

- Hosting platform and whether Windows virtualization/nested virtualization is available.
- Dedicated vs pooled presence desktops and concurrency economics.
- Worker isolation per language/OS and GPU placement for local models.
- Pilot HA/RPO/RTO infrastructure budget.
