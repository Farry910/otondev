using System.Diagnostics;
// Explicit: a WPF-enabled project does not get System.IO from ImplicitUsings, and
// System.Windows.Shapes.Path would otherwise be the only `Path` in scope.
using System.IO;
using System.Security.Principal;
using System.Windows.Automation;
using Otondev.Spike.Common;

namespace Otondev.Spike.Companion;

/// <summary>
/// The interactive companion: least privilege, in a real user session, with a desktop.
///
/// It proves four things about itself before it does any work — that it is not an
/// administrator, that it can see a desktop, that the pipe it is about to trust is owned by the
/// supervisor, and that it can drive a real application to a verified postcondition. It
/// deliberately refuses to run if the first check fails, because a companion that quietly runs
/// elevated would satisfy every other criterion while breaking the one that matters most.
/// </summary>
public static class Program
{
    private const string Component = "companion";

    public static async Task<int> Main(string[] args)
    {
        var sessionArg = ParseInt(args, "--session");
        var selfCheckOnly = args.Contains("--self-check");

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

        if (!ReportIdentity(sessionArg))
        {
            return 2;
        }

        if (selfCheckOnly)
        {
            return 0;
        }

        // Local emergency stop, armed before anything else runs. A stop that only works once
        // the companion is fully up is not an emergency stop.
        var localStop = LocalStop.Arm(Component, cts);

        var supervisor = ConnectToSupervisor(cts.Token);

        var driving = Task.Run(() => DriveTargets(cts.Token), CancellationToken.None);

        if (supervisor is not null)
        {
            await HeartbeatAsync(supervisor, cts.Token);
        }
        else
        {
            // No supervisor to talk to: the companion still has to keep working and still has to
            // honour a local stop. That is the "control plane unreachable" shape one level down.
            Evidence.Record(Component, "degraded-mode", Outcome.Info,
                "no supervisor channel; continuing with local control only");
            try { await Task.Delay(Timeout.Infinite, cts.Token); } catch (OperationCanceledException) { }
        }

        await driving;
        localStop.Dispose();
        supervisor?.Dispose();
        return 0;
    }

    // ---------------------------------------------------------------- self-checks

    /// <summary>
    /// "The companion runs non-administrator" is a criterion, so it is measured and enforced,
    /// not asserted in a comment.
    /// </summary>
    private static bool ReportIdentity(int? expectedSession)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var process = Process.GetCurrentProcess();
        var elevated = Native.IsCurrentProcessElevated();
        var admin = Native.IsCurrentProcessAdministrator();
        var integrity = Launch.CurrentIntegrityLevel();

        Evidence.Record(Component, "identity", Outcome.Info,
            $"user={identity.Name} session={process.SessionId} integrity={integrity} " +
            $"elevated={elevated} administrator={admin} expectedSession={expectedSession?.ToString() ?? "-"}");

        if (elevated || admin)
        {
            Evidence.Record(Component, "non-administrator", Outcome.Fail,
                $"companion is running with administrator rights (elevated={elevated}, admin={admin}, " +
                $"integrity={integrity}); refusing to continue",
                criterion: "the companion runs non-administrator");
            return false;
        }

        Evidence.Record(Component, "non-administrator", Outcome.Pass,
            $"integrity={integrity}, elevated=false, administrator=false",
            criterion: "the companion runs non-administrator");

        // A session id and a desktop are different things: a process can be in session 1 and
        // still be on a window station with no desktop if it was launched without lpDesktop.
        var desktop = HasInteractiveDesktop();
        Evidence.Record(Component, "interactive-desktop", desktop ? Outcome.Pass : Outcome.Fail,
            desktop
                ? $"reachable desktop, {SystemInformationVirtualScreen()}"
                : "no reachable interactive desktop from this process",
            criterion: "a session-0 service launches an interactive companion process in a real logged-in session");

        // SE_TCB_NAME in the companion would mean the least-privilege split had failed.
        var (tcb, error) = Native.TryQueryUserToken(process.SessionId, out _);
        Evidence.Record(Component, "companion-lacks-se-tcb", tcb ? Outcome.Fail : Outcome.Pass,
            tcb
                ? "companion holds SE_TCB_NAME — it is far more privileged than the design allows"
                : $"WTSQueryUserToken refused (win32={error}), as it should be for a least-privilege companion",
            criterion: "the companion runs non-administrator");

        return desktop;
    }

    private static bool HasInteractiveDesktop()
    {
        try
        {
            // Touching the UIA root requires a window station and desktop; a session-0 process
            // without them throws rather than returning an empty tree.
            return AutomationElement.RootElement is not null;
        }
        catch (Exception ex)
        {
            Evidence.Record(Component, "interactive-desktop", Outcome.Info, $"{ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    private static string SystemInformationVirtualScreen()
    {
        try
        {
            var bounds = AutomationElement.RootElement.Current.BoundingRectangle;
            return $"root bounds {bounds.Width:F0}x{bounds.Height:F0}";
        }
        catch (Exception)
        {
            return "root bounds unavailable";
        }
    }

    // ---------------------------------------------------------------- supervisor channel

    /// <summary>
    /// Connect to the supervisor, refusing any pipe the supervisor does not own.
    ///
    /// Trusted owners are LocalSystem (the service) and the current user (console-mode
    /// supervisor during unelevated testing). Anything else — including a pipe squatted by
    /// another process running as this same user — is refused, which is the case a pipe ACL
    /// alone cannot cover.
    /// </summary>
    private static SupervisorChannel? ConnectToSupervisor(CancellationToken ct)
    {
        var trusted = new[]
        {
            IpcClient.WellKnown(WellKnownSidType.LocalSystemSid),
            WindowsIdentity.GetCurrent().User!,
        };

        var sw = Stopwatch.StartNew();
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(20);

        while (DateTime.UtcNow < deadline && !ct.IsCancellationRequested)
        {
            var outcome = IpcClient.ConnectVerified(Ipc.PipeName, trusted, timeoutMs: 1000);
            if (outcome.Connected && outcome.Stream is not null)
            {
                sw.Stop();
                Evidence.Record(Component, "supervisor-channel", Outcome.Pass, outcome.Reason,
                    sw.Elapsed.TotalMilliseconds,
                    "local IPC is mutually authenticated and ACL-restricted");
                return new SupervisorChannel(outcome.Stream);
            }

            if (outcome.ObservedOwner is not null)
            {
                Evidence.Record(Component, "supervisor-channel-refused", Outcome.Pass, outcome.Reason,
                    criterion: "local IPC is mutually authenticated and ACL-restricted");
                return null;
            }

            Thread.Sleep(200);
        }

        sw.Stop();
        Evidence.Record(Component, "supervisor-channel", Outcome.Fail,
            "no supervisor pipe appeared within 20s", sw.Elapsed.TotalMilliseconds);
        return null;
    }

    private static async Task HeartbeatAsync(SupervisorChannel channel, CancellationToken ct)
    {
        await channel.SendAsync("ready", $"companion pid {Environment.ProcessId} in session {Process.GetCurrentProcess().SessionId}", ct);

        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(3), ct);
                await channel.SendAsync("heartbeat", null, ct);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (IOException)
        {
            Evidence.Record(Component, "supervisor-channel", Outcome.Info, "supervisor channel dropped");
        }
    }

    // ---------------------------------------------------------------- driving real apps

    /// <summary>
    /// Drive two targets, for two different reasons.
    ///
    /// The shipped WinForms app is a control: it is a plain Win32 target whose automation
    /// provider we know is sane, so a failure there means the companion's UIA path itself is
    /// broken — most likely a window-station problem from the cross-session launch. Notepad is
    /// the real evidence: a Microsoft application, not built by us, not cooperating on purpose.
    /// Reporting only the second would leave "did the launch work" and "does that app cooperate"
    /// tangled together in one result.
    /// </summary>
    private static void DriveTargets(CancellationToken ct)
    {
        var driver = new UiaDriver(Component);
        const string criterion = "the companion drives a target application and reports a postcondition";

        var targetApp = Path.Combine(AppContext.BaseDirectory, "Otondev.Spike.TargetApp.exe");
        if (File.Exists(targetApp))
        {
            Drive(driver, targetApp, string.Empty, "control target (shipped WinForms app)", criterion, ct);
        }
        else
        {
            Evidence.Record(Component, "drive:control-target", Outcome.Blocked,
                $"shipped target app not found at {targetApp}");
        }

        Drive(driver, Path.Combine(Environment.SystemDirectory, "notepad.exe"), string.Empty,
            "real target (Windows Notepad)", criterion, ct);
    }

    private static void Drive(
        UiaDriver driver, string executable, string arguments, string label, string criterion, CancellationToken ct)
    {
        var check = $"drive:{label}";
        Process? process = null;

        try
        {
            process = Process.Start(new ProcessStartInfo(executable, arguments) { UseShellExecute = false });
            if (process is null)
            {
                Evidence.Record(Component, check, Outcome.Fail, $"could not start {executable}", criterion: criterion);
                return;
            }

            var window = driver.WaitForMainWindow(process, TimeSpan.FromSeconds(20));
            if (window is null)
            {
                // Store-packaged Notepad re-parents into a different process, so our pid has no
                // window. Fall back to finding it by name — and say so, because the fallback is
                // weaker evidence than the pid match.
                window = FindWindowByNameFragment("Notepad", TimeSpan.FromSeconds(10));
                if (window is null)
                {
                    Evidence.Record(Component, check, Outcome.Fail,
                        $"no top-level window for {Path.GetFileName(executable)} within 30s", criterion: criterion);
                    return;
                }
                Evidence.Record(Component, check + ":window", Outcome.Info,
                    "window found by name, not by process id (app re-parented to another process)");
            }

            var titleBefore = UiaDriver.SafeName(window);
            var (editable, adapter) = driver.FindEditable(window, TimeSpan.FromSeconds(10));
            if (editable is null)
            {
                Evidence.Record(Component, check, Outcome.Fail,
                    $"no editable control found in '{titleBefore}'", criterion: criterion);
                return;
            }

            var stamp = $"otondev-sp1 {DateTimeOffset.UtcNow:HH:mm:ss.fff} postcondition probe";
            driver.Report(check, driver.SetTextAndVerify(editable, adapter, stamp), criterion);
            driver.Report(check + ":title", driver.VerifyTitleChanged(window, titleBefore, TimeSpan.FromSeconds(5)), criterion);
        }
        catch (Exception ex)
        {
            Evidence.Record(Component, check, Outcome.Fail, $"{ex.GetType().Name}: {ex.Message}", criterion: criterion);
        }
        finally
        {
            TryKill(process);
            KillByName("notepad");
        }
    }

    private static AutomationElement? FindWindowByNameFragment(string fragment, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var all = AutomationElement.RootElement.FindAll(TreeScope.Children,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window));

                foreach (AutomationElement element in all)
                {
                    if (UiaDriver.SafeName(element).Contains(fragment, StringComparison.OrdinalIgnoreCase))
                    {
                        return element;
                    }
                }
            }
            catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException)
            {
            }

            Thread.Sleep(200);
        }
        return null;
    }

    private static void TryKill(Process? process)
    {
        try
        {
            if (process is { HasExited: false }) process.Kill(entireProcessTree: true);
        }
        catch (Exception)
        {
        }
        process?.Dispose();
    }

    private static void KillByName(string name)
    {
        foreach (var process in Process.GetProcessesByName(name))
        {
            TryKill(process);
        }
    }

    private static int? ParseInt(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length && int.TryParse(args[index + 1], out var value) ? value : null;
    }
}
