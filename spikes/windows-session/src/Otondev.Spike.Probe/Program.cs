using System.ComponentModel;
using System.Diagnostics;
using System.Security.Principal;
using Otondev.Spike.Common;

namespace Otondev.Spike.Probe;

/// <summary>
/// Records what this machine actually is, and what an unprivileged process can and cannot do here.
///
/// Every other measurement in the spike is only interpretable against this. "The cross-session
/// launch failed" means one thing on a box where the caller had SE_TCB_NAME and something
/// completely different on a box where it did not, and six months later nobody will remember
/// which this was.
/// </summary>
public static class Program
{
    private const string Component = "probe";

    public static int Main()
    {
        Environment();
        Sessions();
        PrivilegeBoundary();
        ServiceState();
        return 0;
    }

    private static void Environment()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var process = Process.GetCurrentProcess();

        Evidence.Record(Component, "host", Outcome.Info,
            $"os={System.Environment.OSVersion.VersionString} " +
            $"machine={System.Environment.MachineName} " +
            $"cpus={System.Environment.ProcessorCount} " +
            $"clr={System.Environment.Version}");

        Evidence.Record(Component, "caller", Outcome.Info,
            $"user={identity.Name} sid={identity.User?.Value} session={process.SessionId} " +
            $"integrity={Launch.CurrentIntegrityLevel()} " +
            $"elevated={Native.IsCurrentProcessElevated()} " +
            $"administrator={Native.IsCurrentProcessAdministrator()}");
    }

    private static void Sessions()
    {
        var console = Native.ActiveConsoleSessionId();
        foreach (var session in Native.EnumerateSessions())
        {
            Evidence.Record(Component, "session", Outcome.Info,
                $"id={session.SessionId} station={session.WinStationName} state={session.State} " +
                $"user={(string.IsNullOrEmpty(session.UserName) ? "-" : $"{session.DomainName}\\{session.UserName}")} " +
                $"interactiveCandidate={session.IsInteractiveCandidate}" +
                (session.SessionId == console ? " [active console]" : string.Empty));
        }
    }

    /// <summary>
    /// Probe the exact privilege the architecture depends on.
    ///
    /// ERROR_PRIVILEGE_NOT_HELD (1314) from an unelevated caller is the *expected* result and is
    /// recorded as a pass, because it confirms the mechanism is present and gated exactly where
    /// the design says it is. Getting a token here instead would be the alarming outcome: it
    /// would mean any user process on this box could launch code into another user's session.
    /// </summary>
    private static void PrivilegeBoundary()
    {
        const int errorPrivilegeNotHeld = 1314;

        var target = Native.EnumerateSessions().FirstOrDefault(s => s.IsInteractiveCandidate);
        if (target is null)
        {
            Evidence.Record(Component, "wts-query-user-token", Outcome.Blocked, "no interactive session to probe");
            return;
        }

        var (ok, error) = Native.TryQueryUserToken(target.SessionId, out _);
        var elevated = Native.IsCurrentProcessElevated();

        if (ok)
        {
            Evidence.Record(Component, "wts-query-user-token", elevated ? Outcome.Info : Outcome.Fail,
                elevated
                    ? $"token obtained for session {target.SessionId} (caller is elevated)"
                    : $"an UNELEVATED process obtained a user token for session {target.SessionId} — " +
                      "that is a serious local privilege boundary problem on this host");
            return;
        }

        Evidence.Record(Component, "wts-query-user-token",
            error == errorPrivilegeNotHeld ? Outcome.Pass : Outcome.Info,
            error == errorPrivilegeNotHeld
                ? $"refused with ERROR_PRIVILEGE_NOT_HELD (1314) for session {target.SessionId}: " +
                  "SE_TCB_NAME is required, and only LocalSystem holds it. This is why the design needs a service."
                : $"refused with win32={error} ({new Win32Exception(error).Message}) for session {target.SessionId}");

        Evidence.Record(Component, "cross-session-launch-from-here",
            Outcome.Blocked,
            "CreateProcessAsUser into another session cannot be attempted without the token above; " +
            "this measurement requires the service to be installed and running as LocalSystem",
            criterion: "a session-0 service launches an interactive companion process in a real logged-in session");
    }

    private static void ServiceState()
    {
        try
        {
            var psi = new ProcessStartInfo("sc.exe", $"query {Supervisor.ServiceName}")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using var sc = Process.Start(psi)!;
            var output = sc.StandardOutput.ReadToEnd();
            sc.WaitForExit(5000);

            var installed = sc.ExitCode == 0;
            var running = output.Contains("RUNNING", StringComparison.Ordinal);

            Evidence.Record(Component, "supervisor-service", installed ? Outcome.Info : Outcome.Blocked,
                installed
                    ? $"{Supervisor.ServiceName} is installed and {(running ? "RUNNING" : "not running")}"
                    : $"{Supervisor.ServiceName} is not installed; the session-0 half of the spike has not been run " +
                      "(installation requires administrator)");
        }
        catch (Exception ex)
        {
            Evidence.Record(Component, "supervisor-service", Outcome.Info, $"{ex.GetType().Name}: {ex.Message}");
        }
    }

    private static class Supervisor
    {
        public const string ServiceName = "OtondevSpikeSupervisor";
    }
}
