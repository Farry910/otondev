using System.Diagnostics;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using Otondev.Spike.Common;

namespace Otondev.Spike.Service;

public enum LaunchMode
{
    /// <summary>Real architecture: session 0 → interactive session. Requires LocalSystem.</summary>
    CrossSession,

    /// <summary>
    /// Degraded fallback for running the rest of the spike without administrator rights.
    /// Everything except the cross-session launch itself is exercised identically; the
    /// findings must never quote a same-session run as evidence for the cross-session claim.
    /// </summary>
    SameSession,
}

public sealed record SupervisorOptions(
    LaunchMode Mode,
    string CompanionExePath,
    string ControlPlaneHost,
    int ControlPlanePort,
    TimeSpan TaskInterval,
    bool ShowCompanionWindow);

/// <summary>
/// The supervising half of the pair: discovers the interactive session, launches and re-launches
/// the companion into it, owns the authenticated IPC endpoint, reacts to session changes, and
/// keeps running when the control plane is gone.
///
/// Shared verbatim between the Windows service host and the console host so that the console
/// runs exercise the same code the service runs — a spike whose fallback path is a different
/// implementation measures the fallback, not the design.
/// </summary>
public sealed class SupervisorCore(SupervisorOptions options) : IAsyncDisposable
{
    private readonly SupervisorOptions _options = options;
    private readonly SemaphoreSlim _launchLock = new(1, 1);
    private CancellationTokenSource? _cts;
    private readonly List<Task> _loops = [];

    private SecurityIdentifier? _companionUser;
    private volatile CompanionHandle? _companion;
    private volatile PipeChannel? _channel;

    /// <summary>
    /// Tick at which the current relaunch was provoked. For a first launch this is the launch
    /// itself; for a session change it is the moment the notification arrived, which is what
    /// makes the reconnect number honest — the user does not care when we got around to
    /// calling CreateProcessAsUser, they care how long the desktop was unattended.
    /// </summary>
    private long _relaunchTriggerTick;
    private string _relaunchReason = "initial";
    private int _consecutiveLaunchFailures;
    private volatile bool _contained;

    private sealed record CompanionHandle(
        string LaunchId, int Pid, long LaunchTick, int SessionId,
        SafeProcessHandle? NativeHandle, Process? Managed)
    {
        public bool HasExited
        {
            get
            {
                if (Managed is not null)
                {
                    return Managed.HasExited;
                }
                if (NativeHandle is null || NativeHandle.IsInvalid)
                {
                    return true;
                }
                using var wait = new ProcessWaitHandle(NativeHandle);
                return wait.WaitOne(0);
            }
        }

        public void Kill()
        {
            try
            {
                (Managed ?? Process.GetProcessById(Pid)).Kill(entireProcessTree: true);
            }
            catch (ArgumentException)
            {
                // Already gone.
            }
            catch (InvalidOperationException)
            {
                // Already gone.
            }
            catch (System.ComponentModel.Win32Exception ex)
            {
                SpikeLog.WriteError("companion.kill.failed", $"pid {Pid}", ex);
            }
        }
    }

    private sealed class ProcessWaitHandle : WaitHandle
    {
        public ProcessWaitHandle(SafeProcessHandle handle) =>
            SafeWaitHandle = new SafeWaitHandle(handle.DangerousGetHandle(), ownsHandle: false);
    }

    public void Start()
    {
        SpikePaths.EnsureDirectories();
        _cts = new CancellationTokenSource();
        var ct = _cts.Token;

        _companionUser = ResolveCompanionUser();
        SpikeLog.Write("supervisor.start", "supervisor starting", new
        {
            mode = _options.Mode.ToString(),
            identity = TokenInfo.Describe(),
            companion = _options.CompanionExePath,
            companion_user = _companionUser?.Value,
            control_plane = $"{_options.ControlPlaneHost}:{_options.ControlPlanePort}",
        });

        _relaunchTriggerTick = Environment.TickCount64;
        _loops.Add(Task.Run(() => PipeLoopAsync(ct), CancellationToken.None));
        _loops.Add(Task.Run(() => SuperviseLoopAsync(ct), CancellationToken.None));
        _loops.Add(Task.Run(() => ControlPlaneLoopAsync(ct), CancellationToken.None));
        _loops.Add(Task.Run(() => LocalStopWatchAsync(ct), CancellationToken.None));
    }

    /// <summary>
    /// Called from <c>ServiceBase.OnSessionChange</c>. Logon, unlock, console connect and
    /// remote connect all mean "there is (again) a desktop to be present on"; logoff and
    /// disconnect mean the companion's session is going away.
    /// </summary>
    public void OnSessionChange(string reason, int sessionId, bool desktopAvailable)
    {
        var tick = Environment.TickCount64;
        SpikeLog.Write("session.change", reason, new
        {
            session = sessionId,
            desktop_available = desktopAvailable,
            tick,
        });

        if (!desktopAvailable)
        {
            // Deliberately not killing the companion on lock: the session still exists and the
            // process survives a lock, which is itself one of the facts under test.
            return;
        }

        _relaunchTriggerTick = tick;
        _relaunchReason = reason;
        var current = _companion;
        if (current is not null && current.SessionId != sessionId)
        {
            SpikeLog.Write("companion.stale_session", "target session changed; recycling companion", new
            {
                from = current.SessionId,
                to = sessionId,
            });
            current.Kill();
        }
    }

    // ---------------------------------------------------------------- launch

    private SecurityIdentifier? ResolveCompanionUser()
    {
        if (_options.Mode == LaunchMode.SameSession)
        {
            return WindowsIdentity.GetCurrent().User;
        }

        var session = PickTargetSession();
        if (session is null)
        {
            return null;
        }

        try
        {
            var account = string.IsNullOrEmpty(session.DomainName)
                ? new NTAccount(session.UserName)
                : new NTAccount(session.DomainName, session.UserName);
            return (SecurityIdentifier)account.Translate(typeof(SecurityIdentifier));
        }
        catch (IdentityNotMappedException ex)
        {
            SpikeLog.WriteError("session.sid_resolve.failed", session.UserName, ex);
            return null;
        }
        catch (SystemException ex)
        {
            SpikeLog.WriteError("session.sid_resolve.failed", session.UserName, ex);
            return null;
        }
    }

    /// <summary>
    /// Which session should host the companion? The active console session when it has a user,
    /// otherwise the first interactive candidate — that second case is what covers an RDP-only
    /// or disconnected-but-still-logged-on desktop.
    /// </summary>
    private static Native.SessionInfo? PickTargetSession()
    {
        IReadOnlyList<Native.SessionInfo> sessions;
        try
        {
            sessions = Native.EnumerateSessions();
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            SpikeLog.WriteError("session.enumerate.failed", "WTSEnumerateSessions", ex);
            return null;
        }

        var console = Native.ActiveConsoleSessionId();
        return sessions.FirstOrDefault(s => s.SessionId == console && s.IsInteractiveCandidate)
               ?? sessions.FirstOrDefault(s => s.IsInteractiveCandidate);
    }

    private async Task SuperviseLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var current = _companion;
                if (current is null || current.HasExited)
                {
                    if (current is not null)
                    {
                        SpikeLog.Write("companion.exited", $"pid {current.Pid} is gone", new
                        {
                            pid = current.Pid,
                            launch_id = current.LaunchId,
                            lifetime_ms = Environment.TickCount64 - current.LaunchTick,
                        });
                        _companion = null;
                        _relaunchTriggerTick = Environment.TickCount64;
                        _relaunchReason = "companion-exit";
                    }

                    await TryLaunchAsync(ct).ConfigureAwait(false);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                SpikeLog.WriteError("supervisor.loop.error", "supervise loop", ex);
            }

            await SafeDelay(TimeSpan.FromMilliseconds(500), ct).ConfigureAwait(false);
        }
    }

    private async Task TryLaunchAsync(CancellationToken ct)
    {
        await _launchLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_companion is { } existing && !existing.HasExited)
            {
                return;
            }

            // Containment has to be a latched state, not a one-shot event. The first version of
            // this spike killed the companion on the STOP sentinel and let the supervise loop
            // relaunch it half a second later, which produced 13 launches in 6 seconds and two
            // companions fighting over the same desktop. "Stopped" means stopped until a human
            // clears it.
            if (_contained)
            {
                return;
            }

            var session = _options.Mode == LaunchMode.CrossSession
                ? PickTargetSession()
                : null;

            if (_options.Mode == LaunchMode.CrossSession && session is null)
            {
                // No interactive session to be present in. This is a normal state (nobody is
                // logged on yet after a reboot), so it backs off quietly rather than erroring.
                if (_consecutiveLaunchFailures++ % 20 == 0)
                {
                    SpikeLog.Write("session.none", "no interactive session available yet");
                }
                await SafeDelay(TimeSpan.FromSeconds(2), ct).ConfigureAwait(false);
                return;
            }

            _companionUser ??= ResolveCompanionUser();

            var launchId = Guid.NewGuid().ToString("n")[..12];
            var launchTick = Environment.TickCount64;
            var expectedOwner = WindowsIdentity.GetCurrent().User?.Value ?? "";
            var arguments =
                $"--launch {launchId} --launch-tick {launchTick} " +
                $"--trigger-tick {_relaunchTriggerTick} --reason {_relaunchReason} " +
                $"--expect-server-owner {expectedOwner}";

            SpikeLog.Write("companion.launch.begin", $"launching companion ({_options.Mode})", new
            {
                launch_id = launchId,
                mode = _options.Mode.ToString(),
                session = session?.SessionId ?? Process.GetCurrentProcess().SessionId,
                trigger_tick = _relaunchTriggerTick,
                reason = _relaunchReason,
                tick = launchTick,
            });

            if (_options.Mode == LaunchMode.CrossSession)
            {
                var result = SessionLauncher.Launch(
                    session!.SessionId, _options.CompanionExePath, arguments, _options.ShowCompanionWindow);

                SpikeLog.Write(result.Ok ? "companion.launch.ok" : "companion.launch.failed", result.Stage, new
                {
                    launch_id = launchId,
                    ok = result.Ok,
                    stage = result.Stage,
                    win32 = result.Win32Error,
                    win32_meaning = SessionLauncher.Explain(result.Win32Error),
                    pid = result.Pid,
                    token_elevation_type = result.TokenElevationType,
                    token_integrity = result.TokenIntegrityLevel,
                    token_is_elevated = result.TokenIsElevated,
                    used_linked_token = result.UsedLinkedToken,
                    user_sid = result.UserSid,
                    session = session.SessionId,
                });

                if (!result.Ok)
                {
                    _consecutiveLaunchFailures++;
                    await SafeDelay(Backoff(_consecutiveLaunchFailures), ct).ConfigureAwait(false);
                    return;
                }

                _consecutiveLaunchFailures = 0;
                _companion = new CompanionHandle(
                    launchId, result.Pid, launchTick, session.SessionId, result.Process, null);
            }
            else
            {
                var psi = new ProcessStartInfo(_options.CompanionExePath, arguments)
                {
                    UseShellExecute = false,
                    CreateNoWindow = !_options.ShowCompanionWindow,
                    WorkingDirectory = Path.GetDirectoryName(_options.CompanionExePath) ?? ".",
                };
                var proc = Process.Start(psi);
                if (proc is null)
                {
                    _consecutiveLaunchFailures++;
                    SpikeLog.Write("companion.launch.failed", "Process.Start returned null");
                    await SafeDelay(Backoff(_consecutiveLaunchFailures), ct).ConfigureAwait(false);
                    return;
                }

                _consecutiveLaunchFailures = 0;
                SpikeLog.Write("companion.launch.ok", "same-session launch", new
                {
                    launch_id = launchId,
                    pid = proc.Id,
                    session = proc.SessionId,
                    degraded = "same-session; not evidence for the cross-session criterion",
                });
                _companion = new CompanionHandle(launchId, proc.Id, launchTick, proc.SessionId, null, proc);
            }
        }
        finally
        {
            _launchLock.Release();
        }
    }

    private static TimeSpan Backoff(int failures) =>
        TimeSpan.FromMilliseconds(Math.Min(30_000, 500 * Math.Pow(2, Math.Min(failures, 6))));

    // ------------------------------------------------------------------- ipc

    private async Task PipeLoopAsync(CancellationToken ct)
    {
        var user = _companionUser ?? WindowsIdentity.GetCurrent().User!;
        PipeSecurity security;
        try
        {
            security = PipeAuth.BuildServerAcl(user);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or PrivilegeNotHeldException)
        {
            SpikeLog.WriteError("ipc.acl.failed", "could not build pipe ACL", ex);
            return;
        }

        SpikeLog.Write("ipc.listen", $"pipe {SpikePaths.PipeName}", new
        {
            allowed_user = user.Value,
            expected_image = _options.CompanionExePath,
            instances = PipeAuth.MaxServerInstances,
        });

        var first = true;
        while (!ct.IsCancellationRequested)
        {
            NamedPipeServerStream server;
            try
            {
                server = PipeAuth.CreateServer(SpikePaths.PipeName, security, first);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                if (ct.IsCancellationRequested)
                {
                    break;
                }

                // FirstPipeInstance failing means the name was already taken — that is the
                // squatting case, and it must not be papered over as a transient error.
                // ACCESS_DENIED on a later instance is a different animal: the DACL does not
                // grant the supervisor FILE_CREATE_PIPE_INSTANCE.
                SpikeLog.WriteError(
                    first ? "ipc.squat.suspected" : "ipc.instances.exhausted",
                    SpikePaths.PipeName, ex);
                await SafeDelay(TimeSpan.FromSeconds(first ? 5 : 1), ct).ConfigureAwait(false);
                continue;
            }

            first = false;

            try
            {
                await server.WaitForConnectionAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                await server.DisposeAsync().ConfigureAwait(false);
                break;
            }
            catch (IOException ex)
            {
                SpikeLog.WriteError("ipc.accept.failed", "WaitForConnection", ex);
                await server.DisposeAsync().ConfigureAwait(false);
                continue;
            }

            _ = Task.Run(() => HandleConnectionAsync(server, user, ct), CancellationToken.None);
        }
    }

    private async Task HandleConnectionAsync(
        NamedPipeServerStream server, SecurityIdentifier expectedUser, CancellationToken ct)
    {
        var acceptTick = Environment.TickCount64;
        try
        {
            var peer = PipeAuth.IdentifyClient(server);
            var decision = PipeAuth.Authorize(peer, expectedUser, _options.CompanionExePath);

            if (!decision.Allowed)
            {
                SpikeLog.Write("ipc.rejected", decision.Reason, new
                {
                    peer_pid = peer.Pid,
                    peer_sid = peer.UserSid,
                    peer_user = peer.UserName,
                    peer_image = peer.ImagePath,
                    reason = decision.Reason,
                });

                using var rejectChannel = new PipeChannel(server);
                await rejectChannel.SendAsync(Wire.Rejected, new { reason = decision.Reason }, ct)
                    .ConfigureAwait(false);

                // Let the rejection actually reach the caller. Disconnecting straight after the
                // write discards whatever is still buffered, so a rejected client sees a broken
                // pipe instead of a reason — which is indistinguishable from the supervisor
                // having crashed, and makes the security behaviour impossible to verify.
                try
                {
                    server.WaitForPipeDrain();
                }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException)
                {
                    // Caller left first; nothing more to deliver.
                }
                return;
            }

            SpikeLog.Write("ipc.accepted", decision.Reason, new
            {
                peer_pid = peer.Pid,
                peer_sid = peer.UserSid,
                peer_user = peer.UserName,
                peer_image = peer.ImagePath,
                accept_tick = acceptTick,
            });

            await ServeAsync(server, peer, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            SpikeLog.WriteError("ipc.connection.error", "connection handler", ex);
        }
        finally
        {
            try
            {
                if (server.IsConnected)
                {
                    server.Disconnect();
                }
            }
            catch (IOException)
            {
                // Peer already gone.
            }
            await server.DisposeAsync().ConfigureAwait(false);
        }
    }

    private async Task ServeAsync(NamedPipeServerStream server, PipeAuth.PeerIdentity peer, CancellationToken ct)
    {
        using var channel = new PipeChannel(server);
        _channel = channel;
        var tasksIssued = 0;
        var lastHeartbeat = Environment.TickCount64;
        HelloPayload? hello = null;

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var taskPump = Task.Run(async () =>
        {
            // First task goes out as soon as the companion says hello; the interval only
            // governs repeats, so the measured task latency is not padded by a sleep.
            while (!linked.Token.IsCancellationRequested)
            {
                await SafeDelay(_options.TaskInterval, linked.Token).ConfigureAwait(false);
                if (linked.Token.IsCancellationRequested || hello is null)
                {
                    continue;
                }
                await IssueTaskAsync(channel, ++tasksIssued, linked.Token).ConfigureAwait(false);
            }
        }, CancellationToken.None);

        try
        {
            while (!ct.IsCancellationRequested)
            {
                var frame = await channel.ReceiveAsync(ct).ConfigureAwait(false);
                if (frame is null)
                {
                    SpikeLog.Write("ipc.disconnected", $"companion pid {peer.Pid} closed the channel");
                    break;
                }

                switch (frame.Value.Type)
                {
                    case Wire.Hello:
                        hello = PipeChannel.As<HelloPayload>(frame.Value.Payload);
                        RecordHello(hello);
                        await channel.SendAsync(
                            Wire.HelloAck,
                            new HelloAckPayload(
                                WindowsIdentity.GetCurrent().User?.Value ?? "",
                                _companion?.LaunchId ?? "",
                                Environment.TickCount64,
                                true,
                                null),
                            ct).ConfigureAwait(false);
                        await IssueTaskAsync(channel, ++tasksIssued, ct).ConfigureAwait(false);
                        break;

                    case Wire.Heartbeat:
                        lastHeartbeat = Environment.TickCount64;
                        var beat = PipeChannel.As<HeartbeatPayload>(frame.Value.Payload);
                        SpikeLog.Write("companion.heartbeat", beat?.Health ?? "?", new
                        {
                            pid = peer.Pid,
                            target_pid = beat?.TargetPid ?? 0,
                            age_ms = beat is null ? 0 : Environment.TickCount64 - beat.Tick,
                        });
                        await channel.SendAsync(Wire.HeartbeatAck, new { tick = lastHeartbeat }, ct)
                            .ConfigureAwait(false);
                        break;

                    case Wire.TaskResult:
                        RecordTaskResult(PipeChannel.As<TaskResultPayload>(frame.Value.Payload));
                        break;

                    default:
                        SpikeLog.Write("ipc.unknown_frame", frame.Value.Type);
                        break;
                }
            }
        }
        catch (IOException ex)
        {
            SpikeLog.WriteError("ipc.broken", $"companion pid {peer.Pid}", ex);
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
        finally
        {
            await linked.CancelAsync().ConfigureAwait(false);
            try
            {
                await taskPump.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Expected on shutdown.
            }
            _channel = null;
        }
    }

    private void RecordHello(HelloPayload? hello)
    {
        if (hello is null)
        {
            SpikeLog.Write("companion.hello.malformed", "hello payload did not deserialize");
            return;
        }

        var now = Environment.TickCount64;
        SpikeLog.Write("companion.hello", $"companion pid {hello.Pid} in session {hello.SessionId}", new
        {
            hello.Pid,
            hello.SessionId,
            hello.UserName,
            hello.UserSid,
            hello.IsElevated,
            hello.IsAdministrator,
            hello.IntegrityLevel,
            hello.WindowStation,
            hello.Desktop,
            hello.LaunchId,
        });

        // Start latency: from the supervisor deciding to launch to the companion being
        // authenticated on the channel. Includes process creation, .NET startup and the
        // connect handshake, because all three are on the path the design actually pays for.
        SpikeLog.Write("measure.companion_start_ms", "companion start latency", new
        {
            ms = now - hello.LaunchTick,
            launch_id = hello.LaunchId,
            session = hello.SessionId,
            mode = _options.Mode.ToString(),
        });

        // Reconnect latency: from the provoking event (session change, or companion death) to
        // a live authenticated companion. This is the number an SLO would be written against.
        if (_relaunchReason != "initial")
        {
            SpikeLog.Write("measure.reconnect_ms", $"reconnect after {_relaunchReason}", new
            {
                ms = now - _relaunchTriggerTick,
                reason = _relaunchReason,
                session = hello.SessionId,
                mode = _options.Mode.ToString(),
            });
        }
    }

    private static void RecordTaskResult(TaskResultPayload? result)
    {
        if (result is null)
        {
            SpikeLog.Write("task.result.malformed", "task-result payload did not deserialize");
            return;
        }

        SpikeLog.Write(result.Ok ? "task.ok" : "task.failed", result.Postcondition, new
        {
            result.TaskId,
            result.Ok,
            result.Postcondition,
            result.Observed,
            result.Expected,
            result.Error,
        });
        SpikeLog.Write("measure.task_ms", "target application task", new
        {
            ms = result.DurationMs,
            ok = result.Ok,
            task = result.TaskId,
        });
    }

    private async Task IssueTaskAsync(PipeChannel channel, int sequence, CancellationToken ct)
    {
        var taskId = $"t{sequence:D3}";
        var target = Path.Combine(SpikePaths.WorkDir, $"target-{taskId}.txt");
        var expected = $"otondev-spike {SpikeLog.RunId} {taskId} {Environment.TickCount64}";

        SpikeLog.Write("task.issued", taskId, new { target, expected });
        await channel.SendAsync(
            Wire.RunTask,
            new RunTaskPayload(taskId, "notepad-roundtrip", target, expected),
            ct).ConfigureAwait(false);
    }

    // --------------------------------------------------- control plane / stop

    /// <summary>
    /// Exit criterion 6's third measurement: what the pair does when the control plane is not
    /// there. The spike's control plane is a TCP endpoint that is expected to be closed, so
    /// this loop is really asserting a negative — the supervisor keeps supervising, the
    /// companion keeps working, and local stop keeps working, regardless.
    /// </summary>
    private async Task ControlPlaneLoopAsync(CancellationToken ct)
    {
        var consecutiveFailures = 0;
        var breakerOpenLogged = false;

        while (!ct.IsCancellationRequested)
        {
            var began = Environment.TickCount64;
            try
            {
                using var client = new TcpClient();
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(2));
                await client.ConnectAsync(_options.ControlPlaneHost, _options.ControlPlanePort, timeout.Token)
                    .ConfigureAwait(false);

                consecutiveFailures = 0;
                breakerOpenLogged = false;
                SpikeLog.Write("controlplane.reachable", "control plane connected", new
                {
                    ms = Environment.TickCount64 - began,
                });
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex) when (ex is SocketException or OperationCanceledException)
            {
                consecutiveFailures++;
                var elapsed = Environment.TickCount64 - began;

                if (consecutiveFailures == 1)
                {
                    SpikeLog.Write("measure.controlplane_detect_ms", "time to notice the control plane is gone", new
                    {
                        ms = elapsed,
                        error = ex.GetType().Name,
                    });
                }

                if (consecutiveFailures >= 3 && !breakerOpenLogged)
                {
                    breakerOpenLogged = true;
                    SpikeLog.Write("controlplane.breaker_open", "backing off; companion is unaffected", new
                    {
                        failures = consecutiveFailures,
                        companion_alive = _companion is { } c && !c.HasExited,
                    });
                }
                else if (consecutiveFailures % 5 == 0)
                {
                    SpikeLog.Write("controlplane.unreachable", "still unreachable", new
                    {
                        failures = consecutiveFailures,
                        companion_alive = _companion is { } c2 && !c2.HasExited,
                    });
                }
            }

            await SafeDelay(TimeSpan.FromSeconds(consecutiveFailures >= 3 ? 10 : 3), ct).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Emergency containment that does not depend on the network, the control plane, or the
    /// IPC channel: a sentinel file. The companion watches the same file independently, so a
    /// stop still lands if the supervisor itself is wedged.
    /// </summary>
    private async Task LocalStopWatchAsync(CancellationToken ct)
    {
        var sentinel = Path.Combine(SpikePaths.Root, "STOP");
        var announced = false;
        while (!ct.IsCancellationRequested)
        {
            if (File.Exists(sentinel))
            {
                _contained = true;
                if (!announced)
                {
                    announced = true;
                    var requestedTick = ReadTick(sentinel);
                    SpikeLog.Write("emergency.stop.observed", "STOP sentinel present; containing companion", new
                    {
                        companion_pid = _companion?.Pid ?? 0,
                    });

                    // Measured separately from the companion's own reaction: the two are
                    // independent paths to containment and an operator needs to know that the
                    // slower one is still fast enough.
                    if (requestedTick is { } tick)
                    {
                        SpikeLog.Write("measure.local_stop_ms", "STOP sentinel to supervisor containment", new
                        {
                            ms = Environment.TickCount64 - tick,
                            actor = "supervisor",
                        });
                    }

                    _companion?.Kill();
                }
            }
            else
            {
                if (_contained)
                {
                    _contained = false;
                    _relaunchTriggerTick = Environment.TickCount64;
                    _relaunchReason = "containment-cleared";
                    SpikeLog.Write("emergency.stop.cleared", "STOP sentinel gone; companion may start again");
                }
                announced = false;
            }

            await SafeDelay(TimeSpan.FromMilliseconds(200), ct).ConfigureAwait(false);
        }
    }

    // -------------------------------------------------------------- shutdown

    private int _stopped;

    /// <summary>
    /// Idempotent: the service host calls it from <c>OnStop</c> and again from
    /// <c>Dispose</c>, and the console host calls it explicitly before disposing.
    /// </summary>
    public async Task StopAsync()
    {
        if (Interlocked.Exchange(ref _stopped, 1) == 1)
        {
            return;
        }

        SpikeLog.Write("supervisor.stop", "supervisor stopping");
        if (_cts is not null)
        {
            await _cts.CancelAsync().ConfigureAwait(false);
        }

        var channel = _channel;
        if (channel is not null)
        {
            try
            {
                using var quick = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                await channel.SendAsync(Wire.Stop, new StopPayload("supervisor shutting down"), quick.Token)
                    .ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or OperationCanceledException or ObjectDisposedException)
            {
                // Best effort; the kill below is the guarantee.
            }
        }

        _companion?.Kill();

        try
        {
            await Task.WhenAll(_loops).WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException)
        {
            SpikeLog.Write("supervisor.stop.timeout", "background loops did not drain in 5s");
        }
    }

    private static long? ReadTick(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            return long.TryParse(reader.ReadToEnd().Trim(), out var tick) ? tick : null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    private static async Task SafeDelay(TimeSpan delay, CancellationToken ct)
    {
        try
        {
            await Task.Delay(delay, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Cancellation is the normal exit path for every loop here.
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
        _cts?.Dispose();
        _launchLock.Dispose();
    }
}
