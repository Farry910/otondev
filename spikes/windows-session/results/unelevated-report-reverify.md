# Windows session spike — measured evidence

- events: **102** from `C:\ProgramData\OtondevSpike`
- runs: `unelev-0809-1432`
- window: `2026-08-09T20:32:37.1909283Z` .. `2026-08-09T20:34:21.9544053Z`

## Measurements

| metric | n | min ms | median ms | max ms |
|---|---:|---:|---:|---:|
| `companion_start_ms` | 2 | 234 | 1344 | 1344 |
| `reconnect_ms` | 1 | 422 | 422 | 422 |
| `task_ms` | 4 | 2938 | 3000 | 3172 |
| `local_stop_ms` | 2 | 46 | 62 | 62 |
| `controlplane_detect_ms` | 1 | 2015 | 2015 | 2015 |

Latencies are differences of `Environment.TickCount64` — one machine-wide monotonic
source, so values are comparable across the service and companion processes.

## Companion launches

| when | result | mode/stage | pid | win32 | integrity | elevated | linked token |
|---|---|---|---:|---|---|---|---|
| 20:32:39.379 | ok | same-session launch | 40604 | — | — | — | — |
| 20:33:09.634 | ok | same-session launch | 17420 | — | — | — | — |

## Companion privilege (criterion 4)

| when | session | user | elevated | administrator | integrity | window station | desktop |
|---|---:|---|---|---|---|---|---|
| 20:32:40.086 | 1 | LAPTOP-17SBLA91\Fernando | False | False | Medium(0x2000) | WinSta0 | Default |
| 20:33:09.798 | 1 | LAPTOP-17SBLA91\Fernando | False | False | Medium(0x2000) | WinSta0 | Default |

> Every companion that handshook reported a non-elevated token.

## IPC authentication (criterion 5)

- server accepted the companion: **2**
- server rejected a caller: **1**
- companion authenticated the server: **2** (refused **1**)
- unauthorized caller was **admitted**: 0 (good)
- companion disclosed data to a rogue server: 0 (good)

Rejections:

- `20:32:58.119` pid 20732 (`LAPTOP-17SBLA91\Fernando`, `Otondev.Spike.Probe.exe`) — image C:\Users\Fernando\Music\otondev-SP1\spikes\windows-session\out\Otondev.Spike.Probe.exe is not the expected C:\Users\Fernando\Music\otondev-SP1\spikes\windows-session\out\Otondev.Spike.Companion.exe

Observed pipe DACL:

```json
{"owner":"S-1-5-21-1675797188-2527401836-563471279-1001","rules":[{"sid":"S-1-5-18","account":"NT AUTHORITY\\SYSTEM","rights":"FullControl","type":"Allow"},{"sid":"S-1-5-32-544","account":"BUILTIN\\Administradores","rights":"FullControl","type":"Allow"},{"sid":"S-1-5-21-1675797188-2527401836-563471279-1001","account":"LAPTOP-17SBLA91\\Fernando","rights":"FullControl","type":"Allow"}]}
```

## Session lifecycle (criterion 2)

_no `OnSessionChange` notifications recorded._

- service starts recorded: **0**
- machine shutdowns recorded: **0**
- **no shutdown/start pair** — reboot survival is not evidenced by this log.

## Control plane unreachable (criterion 6)

- unreachable detections: **1**, breaker openings: **1**, repeat notices: **2**, successful connects: **0**
- companion alive while the control plane was down: **3/3** samples
- local stop landed while the control plane was unreachable: **1** time(s)

## Target application postconditions (criterion 3)

| when | task | ok | postcondition | observed | error |
|---|---|---|---|---|---|
| 20:32:43.309 | t001 | yes | typed text is present both in the saved file on disk and in the editor's UIA text | file=contains; uia[ControlType.Document/ValuePattern]=contains | — |
| 20:33:12.784 | t001 | yes | typed text is present both in the saved file on disk and in the editor's UIA text | file=contains; uia[ControlType.Document/ValuePattern]=contains | — |
| 20:33:42.809 | t002 | yes | typed text is present both in the saved file on disk and in the editor's UIA text | file=contains; uia[ControlType.Document/ValuePattern]=contains | — |
| 20:34:12.824 | t003 | yes | typed text is present both in the saved file on disk and in the editor's UIA text | file=contains; uia[ControlType.Document/ValuePattern]=contains | — |

**4/4** task attempts verified the postcondition from both the saved file and the live UI Automation tree.

