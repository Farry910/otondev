using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Principal;
using Otondev.Spike.Common;

namespace Otondev.Spike.Supervisor;

/// <summary>
/// Everything the session-0 service does, in one place so that the same code can be exercised
/// two ways: under the SCM as LocalSystem (the real thing), and as a plain console process in
/// the interactive session (unelevated, for the parts that do not need SE_TCB_NAME).
///
/// The console mode is not a simulation of the service. It runs the identical lifecycle, IPC,
/// health and containment code, and differs in exactly one place — <see cref="LaunchCompanion"/>
/// — which is the one place that genuinely needs the privilege. Keeping the difference to a
/// single, named method is what makes it honest to report results from either mode.
/// </summary>
public sealed class SupervisorCore : IDisposable
{
    public const string ServiceName = "OtondevSpikeSupervisor";

    private readonly bool _crossSession;
    private readonly string _companionPath;
    private readonly string _controlPlaneUrl;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromMilliseconds(1500) };

    private readonly object _gate = new();
    private Process? _companion;
    private DateTimeOffset _companionStartedAt;
    private DateTimeOffset _lastCompanionHeartbeat = DateTimeOffset.MinValue;
    private DateTimeOffset _lastCompanionExit = DateTimeOffset.MinValue;
    private bool _companionReady;
    private int _targetSession = -1;
    private int _restarts;
    private bool _contained;

    /// <summary>Set once the companion says "ready"; used to time start and reconnect.</summary>
    private TaskCompletionSource _readySignal = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public SupervisorCore(bool crossSession, string companionPath, string controlPlaneUrl)
    {
        _crossSession = crossSession;
        _companionPath = companionPath;
        _controlPlaneUrl = controlPlaneUrl;
    }

    private string Component => _crossSession ? "supervisor(service)" : "supervisor(console)";

    // ---------------------------------------------------------------- session discovery

    /// <summary>
    /// Which session should the companion live in?
    ///
    /// The active console session is the answer when someone is physically logged in, but it is
    /// -1 (or 0xFFFFFFFF) at the console lock screen and between logon and shell start, so the
    /// enumeration fallback matters. Returning 0 is always wrong: session 0 has no desktop.
    /// </summary>
    public int DiscoverTargetSession()
    {
        var console = Native.ActiveConsoleSessionId();
        var sessions = Native.EnumerateSessions();

        var detail = string.Join(", ", sessions.Select(s =>
            $"{s.SessionId}:{s.WinStationName}:{s.State}:{(string.IsNullOrEmpty(s.UserName) ? "-" : s.UserName)}"));
        Evidence.Record(Component, "session-discovery", Outcome.Info,
            $"activeConsole={console}; sessions=[{detail}]");

        var candidates = sessions.Where(s => s.IsInteractiveCandidate).ToList();
        if (candidates.Count == 0)
        {
            return -1;
        }

        var preferred = candidates.FirstOrDefault(s => s.SessionId == console)
            ?? candidates.FirstOrDefault(s => s.State == Native.WtsConnectState.Active)
            ?? candidates[0];

        return preferred.SessionId;
    }

    // ---------------------------------------------------------------- companion lifecycle

    private void LaunchCompanion(int sessionId)
    {
        var commandLine = $"\"{_companionPath}\" --session {sessionId}";

        if (_crossSession)
        {
            var result = Launch.AsSessionUser(sessionId, commandLine, Path.GetDirectoryName(_companionPath));
            _companion = SafeGetProcess(result.ProcessId);
            Evidence.Record(Component, "companion-launch", Outcome.Pass,
                $"pid={result.ProcessId} session={sessionId} token={result.TokenSource}",
                criterion: "session-0 service launches an interactive companion process in a real logged-in session");
        }
        else
        {
            var info = new ProcessStartInfo(_companionPath)
            {
                Arguments = $"--session {sessionId}",
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(_companionPath)!,
            };
            _companion = Process.Start(info);
            Evidence.Record(Component, "companion-launch", Outcome.Info,
                $"pid={_companion?.Id} session={sessionId} token=inherited (console mode; same session, no SE_TCB_NAME)");
        }

        _companionStartedAt = DateTimeOffset.UtcNow;
        _companionReady = false;
        _readySignal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    private static Process? SafeGetProcess(int pid)
    {
        try { return Process.GetProcessById(pid); }
        catch (ArgumentException) { return null; }
    }

    private bool CompanionAlive
    {
        get
        {
            lock (_gate)
            {
                try { return _companion is { HasExited: false }; }
                catch (InvalidOperationException) { return false; }
            }
        }
    }

    /// <summary>
    /// Start the companion and wait for it to say it is ready over IPC.
    ///
    /// "Ready" is the companion's own handshake after it has verified the pipe owner and can
    /// reach a desktop — not the moment CreateProcessAsUser returned. Timing to process
    /// creation would produce a flattering number that means nothing operationally.
    /// </summary>
    public async Task<double?> StartCompanionAndAwaitReady(int sessionId, TimeSpan timeout, string criterion)
    {
        lock (_gate)
        {
            if (_contained)
            {
                Evidence.Record(Component, "companion-launch", Outcome.Info, "refused: supervisor is contained");
                return null;
            }
        }

        var sw = Stopwatch.StartNew();
        try
        {
            LaunchCompanion(sessionId);
        }
        catch (Win32Exception ex)
        {
            sw.Stop();
            Evidence.Record(Component, "companion-launch", Outcome.Fail,
                $"{ex.Message} (win32={ex.NativeErrorCode})", sw.Elapsed.TotalMilliseconds, criterion);
            return null;
        }

        var completed = await Task.WhenAny(_readySignal.Task, Task.Delay(timeout)).ConfigureAwait(false);
        sw.Stop();

        if (completed != _readySignal.Task)
        {
            Evidence.Record(Component, "companion-ready", Outcome.Fail,
                $"companion did not report ready within {timeout.TotalSeconds:F0}s",
                sw.Elapsed.TotalMilliseconds, criterion);
            return null;
        }

        Evidence.Record(Component, "companion-ready", Outcome.Pass,
            $"companion ready in session {sessionId}", sw.Elapsed.TotalMilliseconds, criterion);
        return sw.Elapsed.TotalMilliseconds;
    }

    /// <summary>
    /// Watch the companion and bring it back when it dies.
    ///
    /// The reconnect measurement is deliberately taken from *detection* rather than from the
    /// kill, because that is what an operator experiences: the gap includes however long the
    /// supervisor took to notice.
    /// </summary>
    public async Task MonitorAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(250, ct).ConfigureAwait(false);

            lock (_gate)
            {
                if (_contained) continue;
            }

            var session = DiscoverTargetSession();
            if (session < 0)
            {
                continue;
            }

            if (session != _targetSession && _targetSession >= 0 && CompanionAlive)
            {
                Evidence.Record(Component, "session-moved", Outcome.Info,
                    $"target session changed {_targetSession} -> {session}; recycling companion");
                StopCompanion("session change");
            }

            _targetSession = session;

            if (CompanionAlive)
            {
                continue;
            }

            if (_lastCompanionExit == DateTimeOffset.MinValue || _companionReady)
            {
                _lastCompanionExit = DateTimeOffset.UtcNow;
                Evidence.Record(Component, "companion-exit", Outcome.Info,
                    $"companion is not running; restart #{_restarts + 1}");
            }

            _restarts++;
            var elapsed = await StartCompanionAndAwaitReady(
                session, TimeSpan.FromSeconds(30),
                "the pair survives reboot, logoff, lock, and reconnect").ConfigureAwait(false);

            if (elapsed is not null)
            {
                var total = (DateTimeOffset.UtcNow - _lastCompanionExit).TotalMilliseconds;
                Evidence.Record(Component, "companion-reconnect-latency", Outcome.Pass,
                    $"detect+relaunch+ready after restart #{_restarts}", total,
                    "measured: companion start latency, reconnect latency");
            }

            _lastCompanionExit = DateTimeOffset.MinValue;
        }
    }

    public void StopCompanion(string reason)
    {
        lock (_gate)
        {
            try
            {
                if (_companion is { HasExited: false })
                {
                    _companion.Kill(entireProcessTree: true);
                    Evidence.Record(Component, "companion-stop", Outcome.Info, $"killed companion: {reason}");
                }
            }
            catch (Exception ex)
            {
                Evidence.Record(Component, "companion-stop", Outcome.Fail, $"{ex.GetType().Name}: {ex.Message}");
            }
            _companionReady = false;
        }
    }

    /// <summary>
    /// Emergency containment. Kills the companion and refuses to bring it back.
    ///
    /// Nothing in this path touches the network — no control-plane call, no token refresh, no
    /// telemetry flush before acting. That is the whole point of the criterion: containment has
    /// to work precisely when the control plane is the thing that has failed.
    /// </summary>
    public void Contain(string reason)
    {
        lock (_gate) { _contained = true; }
        StopCompanion($"contained: {reason}");
        Evidence.Record(Component, "emergency-containment", Outcome.Pass,
            $"companion terminated and relaunch blocked, no network involved ({reason})",
            criterion: "containment works with the control plane unreachable");
    }

    public void Release()
    {
        lock (_gate) { _contained = false; }
        Evidence.Record(Component, "emergency-containment", Outcome.Info, "containment released");
    }

    // ---------------------------------------------------------------- health

    public sealed record HealthCheck(string Name, bool Ok, string Detail);

    /// <summary>
    /// Health that means something.
    ///
    /// The design doc is explicit: "A child heartbeat only proves the heartbeat loop ran."
    /// So the companion's heartbeat is one row of nine here, and it is not sufficient on its
    /// own — an interactive session must exist, the companion must be a live process, its IPC
    /// must be attached, and the things it depends on must be reachable. Control-plane
    /// reachability is reported but is deliberately *not* fatal, because the architecture
    /// requires the presence pair to degrade rather than die when the control plane is gone.
    /// </summary>
    public async Task<IReadOnlyList<HealthCheck>> EvaluateHealthAsync()
    {
        var checks = new List<HealthCheck>();

        var sessions = Native.EnumerateSessions();
        var interactive = sessions.Where(s => s.IsInteractiveCandidate).ToList();
        checks.Add(new HealthCheck("interactive-session", interactive.Count > 0,
            interactive.Count > 0
                ? $"session {string.Join(",", interactive.Select(s => s.SessionId))}"
                : "no logged-on interactive session"));

        checks.Add(new HealthCheck("companion-process", CompanionAlive,
            CompanionAlive ? $"pid {_companion!.Id}" : "not running"));

        checks.Add(new HealthCheck("companion-ipc", _companionReady,
            _companionReady ? "attached and authenticated" : "no authenticated companion channel"));

        var heartbeatAge = DateTimeOffset.UtcNow - _lastCompanionHeartbeat;
        var heartbeatFresh = _lastCompanionHeartbeat != DateTimeOffset.MinValue && heartbeatAge < TimeSpan.FromSeconds(10);
        checks.Add(new HealthCheck("companion-heartbeat", heartbeatFresh,
            _lastCompanionHeartbeat == DateTimeOffset.MinValue
                ? "never"
                : $"{heartbeatAge.TotalSeconds:F1}s old"));

        var evidenceWritable = TryWriteProbe();
        checks.Add(new HealthCheck("evidence-writable", evidenceWritable,
            evidenceWritable ? Evidence.Path : "cannot append to evidence log"));

        var companionBinary = File.Exists(_companionPath);
        checks.Add(new HealthCheck("companion-binary", companionBinary,
            companionBinary ? _companionPath : $"missing: {_companionPath}"));

        checks.Add(new HealthCheck("restart-budget", _restarts < 10,
            $"{_restarts} restarts this run"));

        checks.Add(new HealthCheck("not-contained", !_contained,
            _contained ? "emergency containment active" : "normal"));

        var (reachable, cpDetail) = await ProbeControlPlaneAsync().ConfigureAwait(false);
        checks.Add(new HealthCheck("control-plane (non-fatal)", reachable, cpDetail));

        return checks;
    }

    private static bool TryWriteProbe()
    {
        try
        {
            var probe = Path.Combine(Path.GetDirectoryName(Evidence.Path)!, ".health-probe");
            File.WriteAllText(probe, DateTimeOffset.UtcNow.ToString("O"));
            File.Delete(probe);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    public async Task<(bool Reachable, string Detail)> ProbeControlPlaneAsync()
    {
        var sw = Stopwatch.StartNew();
        try
        {
            using var response = await _http.GetAsync(_controlPlaneUrl).ConfigureAwait(false);
            sw.Stop();
            return (response.IsSuccessStatusCode,
                $"{_controlPlaneUrl} -> {(int)response.StatusCode} in {sw.ElapsedMilliseconds} ms");
        }
        catch (Exception ex)
        {
            sw.Stop();
            return (false, $"{_controlPlaneUrl} unreachable after {sw.ElapsedMilliseconds} ms ({ex.GetType().Name})");
        }
    }

    // ---------------------------------------------------------------- IPC server

    /// <summary>
    /// Serve the companion channel.
    ///
    /// Layer 1 (the ACL) is applied here at pipe creation; layer 2 (client SID allow-list) runs
    /// after every connect. A caller that gets past the kernel but is not on the list is
    /// disconnected before a single application message is read, and that rejection is recorded
    /// as evidence rather than swallowed.
    /// </summary>
    public async Task ServeAsync(IReadOnlyCollection<SecurityIdentifier> allowedClients, CancellationToken ct)
    {
        var security = Ipc.RestrictTo(allowedClients.ToArray());
        Evidence.Record(Component, "ipc-acl", Outcome.Info,
            $"pipe {Ipc.PipeName} granted to [{string.Join(", ", allowedClients.Select(IpcClient.Describe))}]",
            criterion: "local IPC is mutually authenticated and ACL-restricted");

        while (!ct.IsCancellationRequested)
        {
            NamedPipeServerStream server;
            try
            {
                server = Ipc.CreateServer(security);
            }
            catch (Exception ex)
            {
                Evidence.Record(Component, "ipc-listen", Outcome.Fail, $"{ex.GetType().Name}: {ex.Message}");
                return;
            }

            try
            {
                await server.WaitForConnectionAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                await server.DisposeAsync().ConfigureAwait(false);
                return;
            }

            _ = Task.Run(() => HandleClientAsync(server, allowedClients, ct), CancellationToken.None);
        }
    }

    private async Task HandleClientAsync(
        NamedPipeServerStream server,
        IReadOnlyCollection<SecurityIdentifier> allowedClients,
        CancellationToken ct)
    {
        try
        {
            var clientSid = Ipc.ClientSid(server);
            if (clientSid is null || !allowedClients.Contains(clientSid))
            {
                Evidence.Record(Component, "ipc-client-rejected", Outcome.Pass,
                    $"disconnected caller {(clientSid is null ? "<unreadable>" : IpcClient.Describe(clientSid))} " +
                    "— not on the allow-list",
                    criterion: "an unauthorized local caller is rejected");
                server.Disconnect();
                return;
            }

            Evidence.Record(Component, "ipc-client-accepted", Outcome.Info, IpcClient.Describe(clientSid));

            while (!ct.IsCancellationRequested && server.IsConnected)
            {
                var message = await Ipc.ReadLineAsync(server, ct).ConfigureAwait(false);
                if (message is null) break;

                switch (message.Op)
                {
                    case "ready":
                        lock (_gate) { _companionReady = true; _lastCompanionHeartbeat = DateTimeOffset.UtcNow; }
                        _readySignal.TrySetResult();
                        Evidence.Record(Component, "companion-handshake", Outcome.Pass, message.Payload ?? "ready");
                        break;

                    case "heartbeat":
                        lock (_gate) { _lastCompanionHeartbeat = DateTimeOffset.UtcNow; }
                        break;

                    case "result":
                        Evidence.Record(Component, "companion-result", Outcome.Info, message.Payload ?? string.Empty);
                        break;

                    case "health":
                        var checks = await EvaluateHealthAsync().ConfigureAwait(false);
                        var payload = string.Join("; ", checks.Select(c => $"{c.Name}={(c.Ok ? "ok" : "BAD")}:{c.Detail}"));
                        await Ipc.WriteLineAsync(server, new Ipc.Message("health", message.Id, payload), ct)
                            .ConfigureAwait(false);
                        break;

                    default:
                        await Ipc.WriteLineAsync(server, new Ipc.Message("error", message.Id, "unknown op"), ct)
                            .ConfigureAwait(false);
                        break;
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Evidence.Record(Component, "ipc-session", Outcome.Info, $"channel ended: {ex.GetType().Name}");
        }
        finally
        {
            lock (_gate) { _companionReady = false; }
            await server.DisposeAsync().ConfigureAwait(false);
        }
    }

    // ---------------------------------------------------------------- session change

    /// <summary>
    /// The reboot/logoff/lock/reconnect criterion, as it actually arrives: SCM control 0x0E.
    ///
    /// Lock and unlock deliberately do nothing to the companion. A locked workstation still has
    /// a live session and a live desktop; tearing the companion down on lock would be a
    /// self-inflicted outage every time the user walks away.
    /// </summary>
    public void OnSessionChange(ServiceHost.SessionEvent evt, int sessionId)
    {
        Evidence.Record(Component, "session-change", Outcome.Info, $"{evt} on session {sessionId}",
            criterion: "the pair survives reboot, logoff, lock, and reconnect");

        switch (evt)
        {
            case ServiceHost.SessionEvent.SessionLogoff:
            case ServiceHost.SessionEvent.ConsoleDisconnect:
            case ServiceHost.SessionEvent.RemoteDisconnect:
                if (sessionId == _targetSession)
                {
                    StopCompanion($"{evt} on target session {sessionId}");
                }
                break;

            case ServiceHost.SessionEvent.SessionLogon:
            case ServiceHost.SessionEvent.ConsoleConnect:
            case ServiceHost.SessionEvent.RemoteConnect:
                // The monitor loop notices the session and (re)launches; doing it here as well
                // would race it and double-launch.
                break;

            case ServiceHost.SessionEvent.SessionLock:
            case ServiceHost.SessionEvent.SessionUnlock:
                break;
        }
    }

    public void Dispose()
    {
        _http.Dispose();
        _companion?.Dispose();
    }
}
