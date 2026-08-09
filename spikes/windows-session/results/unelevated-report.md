# Windows session spike — measured evidence

- events: **75** from `C:\ProgramData\OtondevSpike-s83866095`
- runs: `verify-3`
- window: `2026-08-09T19:57:03.8065084Z` .. `2026-08-09T19:59:52.1002648Z`

## Measurements

| metric | n | min ms | median ms | max ms |
|---|---:|---:|---:|---:|
| `companion_start_ms` | 2 | 156 | 344 | 344 |
| `reconnect_ms` | 1 | 156 | 156 | 156 |
| `task_ms` | 2 | 2438 | 2641 | 2641 |
| `local_stop_ms` | 2 | 47 | 172 | 172 |
| `controlplane_detect_ms` | 1 | 2015 | 2015 | 2015 |

Latencies are differences of `Environment.TickCount64` — one machine-wide monotonic
source, so values are comparable across the service and companion processes.

## Companion launches

| when | result | mode/stage | pid | win32 | integrity | elevated | linked token |
|---|---|---|---:|---|---|---|---|
| 19:57:03.945 | ok | same-session launch | 37984 | — | — | — | — |
| 19:57:20.879 | ok | same-session launch | 39500 | — | — | — | — |

## Companion privilege (criterion 4)

| when | session | user | elevated | administrator | integrity | window station | desktop |
|---|---:|---|---|---|---|---|---|
| 19:57:04.205 | 1 | LAPTOP-17SBLA91\Fernando | False | False | Medium(0x2000) | WinSta0 | Default |
| 19:57:21.006 | 1 | LAPTOP-17SBLA91\Fernando | False | False | Medium(0x2000) | WinSta0 | Default |

> Every companion that handshook reported a non-elevated token.

## IPC authentication (criterion 5)

- server accepted the companion: **2**
- server rejected a caller: **8**
- companion authenticated the server: **2** (refused **1**)
- unauthorized caller was **admitted**: 0 (good)
- companion disclosed data to a rogue server: 0 (good)

Rejections:

- `19:57:09.542` pid 10852 (`LAPTOP-17SBLA91\Fernando`, `Otondev.Spike.Probe.exe`) — image C:\Users\Fernando\AppData\Local\Temp\claude\C--Users-Fernando-Music-otondev\83866095-335d-49f8-ace6-5bf8f8d842ea\scratchpad\sp1-out\Otondev.Spike.Probe.exe is not the expected C:\Users\Fernando\AppData\Local\Temp\claude\C--Users-Fernando-Music-otondev\83866095-335d-49f8-ace6-5bf8f8d842ea\scratchpad\sp1-out\Otondev.Spike.Companion.exe
- `19:57:17.356` pid 31272 (`LAPTOP-17SBLA91\Fernando`, `Otondev.Spike.Companion.exe`) — image C:\Users\Fernando\Music\otondev-SP1\spikes\windows-session\out\Otondev.Spike.Companion.exe is not the expected C:\Users\Fernando\AppData\Local\Temp\claude\C--Users-Fernando-Music-otondev\83866095-335d-49f8-ace6-5bf8f8d842ea\scratchpad\sp1-out\Otondev.Spike.Companion.exe
- `19:58:41.914` pid 40276 (`LAPTOP-17SBLA91\Fernando`, `Otondev.Spike.Companion.exe`) — image C:\Users\Fernando\Music\otondev-SP1\spikes\windows-session\out\Otondev.Spike.Companion.exe is not the expected C:\Users\Fernando\AppData\Local\Temp\claude\C--Users-Fernando-Music-otondev\83866095-335d-49f8-ace6-5bf8f8d842ea\scratchpad\sp1-out\Otondev.Spike.Companion.exe
- `19:58:47.597` pid 38100 (`LAPTOP-17SBLA91\Fernando`, `Otondev.Spike.Companion.exe`) — image C:\Users\Fernando\Music\otondev-SP1\spikes\windows-session\out\Otondev.Spike.Companion.exe is not the expected C:\Users\Fernando\AppData\Local\Temp\claude\C--Users-Fernando-Music-otondev\83866095-335d-49f8-ace6-5bf8f8d842ea\scratchpad\sp1-out\Otondev.Spike.Companion.exe
- `19:58:53.270` pid 40908 (`LAPTOP-17SBLA91\Fernando`, `Otondev.Spike.Companion.exe`) — image C:\Users\Fernando\Music\otondev-SP1\spikes\windows-session\out\Otondev.Spike.Companion.exe is not the expected C:\Users\Fernando\AppData\Local\Temp\claude\C--Users-Fernando-Music-otondev\83866095-335d-49f8-ace6-5bf8f8d842ea\scratchpad\sp1-out\Otondev.Spike.Companion.exe
- `19:58:58.920` pid 22344 (`LAPTOP-17SBLA91\Fernando`, `Otondev.Spike.Companion.exe`) — image C:\Users\Fernando\Music\otondev-SP1\spikes\windows-session\out\Otondev.Spike.Companion.exe is not the expected C:\Users\Fernando\AppData\Local\Temp\claude\C--Users-Fernando-Music-otondev\83866095-335d-49f8-ace6-5bf8f8d842ea\scratchpad\sp1-out\Otondev.Spike.Companion.exe
- `19:58:59.710` pid 21088 (`LAPTOP-17SBLA91\Fernando`, `powershell.exe`) — image C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe is not the expected C:\Users\Fernando\AppData\Local\Temp\claude\C--Users-Fernando-Music-otondev\83866095-335d-49f8-ace6-5bf8f8d842ea\scratchpad\sp1-out\Otondev.Spike.Companion.exe
- `19:58:59.815` pid 41312 (`LAPTOP-17SBLA91\Fernando`, `Otondev.Spike.Probe.exe`) — image C:\Users\Fernando\Music\otondev-SP1\spikes\windows-session\out\Otondev.Spike.Probe.exe is not the expected C:\Users\Fernando\AppData\Local\Temp\claude\C--Users-Fernando-Music-otondev\83866095-335d-49f8-ace6-5bf8f8d842ea\scratchpad\sp1-out\Otondev.Spike.Companion.exe

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
- companion alive while the control plane was down: **1/3** samples
- local stop landed while the control plane was unreachable: **1** time(s)

## Target application postconditions (criterion 3)

| when | task | ok | postcondition | observed | error |
|---|---|---|---|---|---|
| 19:57:06.694 | t001 | yes | typed text is present both in the saved file on disk and in the editor's UIA text | file=contains; uia[ControlType.Document/ValuePattern]=contains | — |
| 19:57:23.702 | t001 | yes | typed text is present both in the saved file on disk and in the editor's UIA text | file=contains; uia[ControlType.Document/ValuePattern]=contains | — |

**2/2** task attempts verified the postcondition from both the saved file and the live UI Automation tree.

