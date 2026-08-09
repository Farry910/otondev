using System.Security.Principal;
using Otondev.Spike.Common;

namespace Otondev.Spike.Supervisor;

/// <summary>
/// The supervisor runs one of two ways and decides for itself which:
///
///   started by the SCM   -> service mode: LocalSystem, session 0, real cross-session launch
///   started from a shell -> console mode: interactive session, no SE_TCB_NAME
///
/// <c>StartServiceCtrlDispatcher</c> is what tells us, so there is no flag to get wrong and no
/// way to accidentally file console-mode results as if the service had produced them. Every
/// evidence row carries which mode wrote it.
/// </summary>
public static class Program
{
    private static SupervisorCore? _current;

    public static async Task<int> Main(string[] args)
    {
        var companionPath = Environment.GetEnvironmentVariable("OTONDEV_SPIKE_COMPANION")
            ?? Path.Combine(AppContext.BaseDirectory, "Otondev.Spike.Companion.exe");

        var controlPlane = Environment.GetEnvironmentVariable("OTONDEV_SPIKE_CONTROL_PLANE")
            // Deliberately unreachable by default. "Control plane down" is the interesting case,
            // so it is the one you get unless you go out of your way to ask for the other.
            ?? "http://127.0.0.1:59997/health";

        if (!args.Contains("--console") && ServiceHost.Run(
                SupervisorCore.ServiceName,
                ct => SteadyStateAsync(true, companionPath, controlPlane, ct).GetAwaiter().GetResult(),
                onSessionChange: (evt, session) => _current?.OnSessionChange(evt, session),
                onUserControl: control =>
                {
                    if (control == ServiceHost.ControlContain) _current?.Contain("sc control 128, no network in the path");
                    else if (control == ServiceHost.ControlRelease) _current?.Release();
                }))
        {
            return 0;
        }

        // Not started by the SCM.
        Console.WriteLine($"[supervisor] console mode; evidence -> {Evidence.Path}");
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        return args.Contains("--scenario")
            ? await ScenarioAsync(companionPath, controlPlane, cts.Token)
            : await SteadyStateAsync(false, companionPath, controlPlane, cts.Token);
    }

    /// <summary>What the service does forever: serve IPC, keep the companion alive, report health.</summary>
    private static async Task<int> SteadyStateAsync(
        bool crossSession, string companionPath, string controlPlane, CancellationToken ct)
    {
        using var core = new SupervisorCore(crossSession, companionPath, controlPlane);
        _current = core;

        Evidence.Record(crossSession ? "supervisor(service)" : "supervisor(console)", "start", Outcome.Info,
            $"identity={WindowsIdentity.GetCurrent().Name} " +
            $"session={System.Diagnostics.Process.GetCurrentProcess().SessionId} " +
            $"integrity={Launch.CurrentIntegrityLevel()} " +
            $"elevated={Native.IsCurrentProcessElevated()}");

        var allowed = AllowedClients(core, crossSession);
        var serve = core.ServeAsync(allowed, ct);
        var monitor = core.MonitorAsync(ct);
        var health = HealthLoopAsync(core, ct);

        try
        {
            await Task.WhenAll(serve, monitor, health);
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }

        core.StopCompanion("supervisor shutting down");
        return 0;
    }

    /// <summary>
    /// Who may talk to the pipe.
    ///
    /// In service mode this is LocalSystem plus the *specific account* logged into the target
    /// session — not Users, not Authenticated Users, not Everyone. In console mode the
    /// supervisor is that user already, so it grants itself. The narrow grant is the whole
    /// mechanism behind "an unauthorized local caller is rejected"; a broad one would make the
    /// test pass for the wrong reason.
    /// </summary>
    private static SecurityIdentifier[] AllowedClients(SupervisorCore core, bool crossSession)
    {
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);

        if (!crossSession)
        {
            return [system, WindowsIdentity.GetCurrent().User!];
        }

        var session = core.DiscoverTargetSession();
        if (session < 0)
        {
            return [system];
        }

        var (sid, error) = Launch.TrySessionUserSid(session);
        if (sid is null)
        {
            Evidence.Record("supervisor(service)", "ipc-acl", Outcome.Fail,
                $"could not resolve the session {session} user SID (win32={error}); granting LocalSystem only");
            return [system];
        }

        return [system, sid];
    }

    private static async Task HealthLoopAsync(SupervisorCore core, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(15), ct).ConfigureAwait(false);
            await ReportHealthAsync(core).ConfigureAwait(false);
        }
    }

    private static async Task ReportHealthAsync(SupervisorCore core)
    {
        var checks = await core.EvaluateHealthAsync();
        var bad = checks.Where(c => !c.Ok && !c.Name.StartsWith("control-plane", StringComparison.Ordinal)).ToList();
        var summary = string.Join("; ", checks.Select(c => $"{c.Name}={(c.Ok ? "ok" : "BAD")}({c.Detail})"));

        Evidence.Record("supervisor", "health", bad.Count == 0 ? Outcome.Pass : Outcome.Info, summary,
            criterion: "health checks cover dependency readiness, not just \"the heartbeat loop ran\"");
    }

    /// <summary>
    /// The unelevated scenario: everything the criteria ask for that does not require SE_TCB_NAME,
    /// run end to end in one process so the numbers come from one consistent environment.
    /// </summary>
    private static async Task<int> ScenarioAsync(string companionPath, string controlPlane, CancellationToken ct)
    {
        using var core = new SupervisorCore(false, companionPath, controlPlane);
        _current = core;

        Evidence.Record("scenario", "begin", Outcome.Info,
            $"identity={WindowsIdentity.GetCurrent().Name} " +
            $"session={System.Diagnostics.Process.GetCurrentProcess().SessionId} " +
            $"integrity={Launch.CurrentIntegrityLevel()} " +
            $"elevated={Native.IsCurrentProcessElevated()} " +
            $"administrator={Native.IsCurrentProcessAdministrator()}");

        var allowed = AllowedClients(core, false);
        using var serveCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var serve = core.ServeAsync(allowed, serveCts.Token);

        var session = core.DiscoverTargetSession();
        if (session < 0)
        {
            Evidence.Record("scenario", "session-discovery", Outcome.Fail, "no interactive session to target");
            return 1;
        }

        // 1. Start latency, measured to the companion's own readiness handshake.
        var start = await core.StartCompanionAndAwaitReady(
            session, TimeSpan.FromSeconds(60),
            "measured: companion start latency");

        if (start is null)
        {
            Evidence.Record("scenario", "abort", Outcome.Fail, "companion never became ready");
            serveCts.Cancel();
            return 1;
        }

        // 2. Let the companion drive the target application and report its postcondition.
        //    The companion records that evidence itself; we wait for it to finish.
        await Task.Delay(TimeSpan.FromSeconds(25), ct);

        // 3. Health with the control plane unreachable.
        await ReportHealthAsync(core);
        var (reachable, detail) = await core.ProbeControlPlaneAsync();
        Evidence.Record("scenario", "control-plane-unreachable", reachable ? Outcome.Info : Outcome.Pass,
            reachable
                ? $"control plane WAS reachable, so this run does not test the degraded path: {detail}"
                : $"companion and supervisor still healthy with the control plane down: {detail}",
            criterion: "measured: behaviour with the control plane unreachable");

        // 4. Kill the companion out from under the supervisor and time the recovery.
        var monitor = core.MonitorAsync(ct);
        core.StopCompanion("scenario: simulated companion crash");
        await Task.Delay(TimeSpan.FromSeconds(30), ct);

        // 5. Emergency containment, with the control plane still down.
        core.Contain("scenario: operator emergency stop");
        await Task.Delay(TimeSpan.FromSeconds(3), ct);

        var stillRunning = System.Diagnostics.Process.GetProcessesByName("Otondev.Spike.Companion").Length;
        Evidence.Record("scenario", "containment-effective",
            stillRunning == 0 ? Outcome.Pass : Outcome.Fail,
            stillRunning == 0
                ? "no companion process survives containment"
                : $"{stillRunning} companion process(es) still running after containment",
            criterion: "containment works with the control plane unreachable");

        serveCts.Cancel();
        try { await Task.WhenAll(serve, monitor); } catch (OperationCanceledException) { }

        Evidence.Record("scenario", "end", Outcome.Info, "unelevated scenario complete");
        return 0;
    }
}
