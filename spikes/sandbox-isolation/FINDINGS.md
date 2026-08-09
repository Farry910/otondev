# SP2 — sandbox isolation spike: findings

## Verdict: **CONTINUE**

The isolation model in `secure-box-and-supervision.md` is achievable on a Linux-container host
profile. Every containment property S10 depends on held under test, with a positive control
proving each negative result was enforcement rather than a broken probe, and the repository's
own 179-test suite ran to completion inside the sandbox while reaching nothing but an
explicitly allow-listed registry.

**One criterion does not hold the way it is likely to be implemented.** CPU quota throttles and
never terminates, so `--cpus` cannot enforce a CPU-seconds budget. A supervisor watchdog can,
and this spike measures one doing it. See §3 — that section is the reason to read this document
rather than the summary line.

Reproduce with `node run-spike.mjs`; machine-readable output in `results/sp2-run.json`.

---

## 1. Host profile this holds for

| | |
|---|---|
| Runtime | Docker 29.6.1, linux/amd64 |
| Host | Windows 11 26200 via Docker Desktop / WSL2 |
| Storage driver | `overlayfs`, `--storage-opt size` **supported** |
| cgroup | v2 |
| Security options | `seccomp=builtin`, `cgroupns` |
| Worker image | `node:22-bookworm-slim` pinned by digest, non-root uid 10001 |

Workspace baseline, applied to every container measured — not just the ones being measured:
`--cap-drop ALL`, `--security-opt no-new-privileges`, `--read-only` rootfs, tmpfs `/work`,
`/home/worker` and `/tmp` (the last `noexec`), and one Docker network per workspace.

## 2. What held

Every row below has a control. That is the whole methodology: "could not reach the vault" is
worthless unless the same probe reaches the vault when isolation is removed.

| Property | Result | Control that makes it meaningful |
|---|---|---|
| Escape suite reaches nothing | **7/7 contained** — host socket, vault, cloud metadata, LAN service, default gateway, public internet, DNS | The identical suite on a bridge network reached vault, LAN, internet and DNS |
| Another workspace unreachable | `ENETUNREACH` to the peer's IP | Two workspaces on a *shared* network reach each other, so the probe works and per-workspace networks are what stop it |
| Deny-by-default egress | Direct connections reach nothing even with a proxy configured | — |
| Explicit allow-list | `registry.npmjs.org` → 200; `example.com` → 403 | Both through the same proxy |
| Egress logged | Both the permitted and the refused request appear in the log | A denial-only log cannot see exfiltration through an allowed host |
| Memory quota terminates | exit 137, OOM-killed | — |
| PID quota terminates | 300 forks against a limit of 32 killed the workload (`exited\|2`) | The same fork bomb with no limit was still running |
| CPU-seconds terminates | Watchdog killed the workload at **2.32 CPU-seconds against a 2 s budget** (`exited\|137`) | `--cpus` alone throttled an identical loop forever — see §3 |
| Disk quota | `--storage-opt size=512m` accepted on this driver | Fallback path (size-bounded tmpfs) implemented for drivers without pquota |
| Wall-clock terminates | supervisor SIGKILL → `exited\|137` | — |
| Teardown after a crash | Container SIGKILLed mid-run; removal took 82–118 ms; tmpfs went with it; network removed; 0 dangling volumes | — |
| Real test suite | **179/179 passed** inside the sandbox: clone at base SHA, `pnpm install` through the allow-list, `pnpm test` | — |

### Measurements

| | |
|---|---|
| Cold workspace create (to first usable command) | ~400 ms |
| Warm create | ~410–440 ms |
| Teardown | ~130–155 ms |
| Create + teardown per attempt | **~570 ms** |
| `pnpm install` through the proxy | 6.2 s |
| Full test suite in-sandbox | 1.6 s |

A fresh workspace per `(workflow, attempt)` costs about half a second. That is far below the
cost of any task worth sandboxing, so workspace reuse should never be proposed as an
optimisation — it would trade the isolation boundary for nothing.

## 3. CPU: the runtime cannot terminate, the supervisor can

S10 says quotas "terminate rather than degrade". Memory, PIDs and wall clock terminate on their
own. **CPU never does.** Measured: a busy loop under `--cpus 0.5` ran 4003 ms wall and consumed
2002 ms of CPU — exactly 0.5 cores, throttled forever.

That is not a Docker limitation to engineer around. CFS quota is a rate limit; there is no
container-level "kill after N CPU-seconds", and there should not be one. So the enforcement has
to move up a layer, and this spike measured it working rather than merely recommending it:

> The supervisor samples the workspace's own cgroup accounting (`/sys/fs/cgroup/cpu.stat`,
> `usage_usec` — available inside the container under `cgroupns=private`, needing no host
> access) every 250 ms, and kills when the budget is spent. Against a 2-second budget it
> killed at **2.32 CPU-seconds: a 0.32 s overshoot**.

Two consequences worth writing into S10 rather than rediscovering:

1. **`--cpus` is a fairness control, not a budget.** Set it to stop one workspace starving the
   host. It will never enforce `budget.cpu_seconds` (contracts §3), and a review that sees the
   flag and ticks the box has signed off on something that does not exist.
2. **The overshoot is the sampling interval times the core count**, and it is a property to
   state, not to eliminate. At 250 ms and one core, a workflow can exceed its CPU budget by up
   to ~0.25 s plus scheduling slop. If a tighter bound is ever needed the interval is the dial,
   and the cost is sampling overhead on every live workspace.

## 4. Two findings worth carrying into S10 and S11

**A workspace cannot terminate its own workspace.** The kernel ignores `SIGKILL` sent to a PID
namespace's init from inside that namespace. `kill -9 1` returned 0 and the container kept
running. Good news twice over: a compromised workload cannot destroy its own evidence by
killing the workspace, and containment is therefore always the supervisor's to enforce from the
ancestor namespace. S10's teardown path must never rely on asking the workspace to stop.

**HTTPS egress can only be logged at host granularity.** The proxy sees `CONNECT host:443` and
nothing more. Logging URLs would require TLS interception, which means a private CA in the
workspace trust store and a proxy that can read every credential in flight — the wrong trade
for a component whose purpose is containment. S19's canary-exfiltration corpus should assume
host-level egress logs and design its canaries accordingly.

## 5. Residual risks

1. **Shared kernel.** Everything here rests on namespaces and cgroups. A kernel LPE defeats all
   of it at once. Not evaluated: gVisor, Kata, Firecracker. For A3-autonomy work on untrusted
   repository code, a VM boundary should be re-examined before pilot.
2. **This is not the production host profile.** Docker Desktop on WSL2 is a developer
   configuration. The escape suite must be re-run on the real host before S10 is signed off —
   `--storage-opt size` in particular depends on the storage driver and silently degrades to
   "no disk quota" on overlay2 without project quotas.
3. **No user-namespace remapping.** The workload runs as uid 10001 inside *and* outside. A
   container escape lands as an unprivileged host user rather than root, which is better than
   nothing and worse than `userns-remap`.
4. **Exfiltration through an allowed host is unaddressed here.** The allow-list stops
   `attacker.test`; it does not stop data leaving inside a request to `registry.npmjs.org`.
   That is S19's problem, and this spike does not claim to have solved it.
5. **`host.docker.internal` is a Docker Desktop convenience.** On a Linux host the vault and
   LAN probes need the real addresses; the suite takes them from `VAULT_ADDR` / `LAN_ADDR` so
   this is configuration, not a rewrite.

## 6. S10 exit criteria: reachable vs still unproven

**Known reachable** (demonstrated here):

- the escape suite fails to reach the host socket, vault, cloud metadata, LAN, and another workspace
- deny-by-default egress with an explicit allow-list, and egress logging
- memory, PID, disk and wall-clock quotas terminate rather than degrade, and CPU-seconds
  terminates once the supervisor watchdog in §3 exists — S10 must build that watchdog; it is
  not something the runtime provides
- teardown completes after a worker crash, leaving nothing mounted or running
- fresh workspace per `(workflow, attempt)`, verified and digest-pinned worker images, minimal mounts
- a real repository's real test suite runs to completion inside the sandbox

**Still unproven:**

- **the presence desktop leg of the escape suite** — there is no presence desktop yet, and SP1
  has not reported. Re-run the suite with a `PEER_WORKSPACE_ADDR` pointing at the companion's
  session once SP1 lands.
- **"a fenced worker loses its publish capability"** — a capability-broker property, not an
  isolation one. S5 owns it; nothing here tests it.
- **the production host profile** — see §5.2.

The CPU-seconds watchdog is demonstrated here but is spike code. S10 owns building the real
one; §3 gives the mechanism and the measured overshoot it should be held to.

## 7. Handing the result back

```powershell
.\board\scripts\board.ps1 clear-gate S10 -Note "SP2: CONTINUE on a Linux-container profile. 19/19 checks, 179/179 tests in-sandbox. One design change needed: cpu_seconds needs a supervisor watchdog, --cpus throttles and never kills. Re-run the escape suite on the production host before sign-off."
```
