using System.Diagnostics;
using Otondev.Spike.Common;

namespace Otondev.Spike.Probe;

/// <summary>
/// Establishes, from the caller's real identity, which of the mechanisms the design depends on
/// are actually available here — before any of the moving parts run.
///
/// The most valuable single line this produces is the <c>WTSQueryUserToken</c> result. From an
/// ordinary interactive process it must fail with ERROR_PRIVILEGE_NOT_HELD (1314), and that
/// failure is not a defect: it is the empirical justification for the session-0 service
/// existing at all. If it ever succeeded unelevated, the architecture would be carrying a
/// service it does not need.
/// </summary>
internal static class Preflight
{
    internal static int Run()
    {
        var identity = TokenInfo.Describe();
        SpikeLog.Write("preflight.identity", "probe identity", identity);

        Console.WriteLine("=== identity ===");
        Console.WriteLine($"  user            : {identity.UserName} ({identity.UserSid})");
        Console.WriteLine($"  session         : {identity.SessionId}");
        Console.WriteLine($"  elevated        : {identity.IsElevated}   (type {identity.ElevationType})");
        Console.WriteLine($"  administrator   : {identity.IsAdministrator}");
        Console.WriteLine($"  integrity       : {identity.IntegrityLevel}");
        Console.WriteLine($"  window station  : {identity.WindowStation}");
        Console.WriteLine($"  desktop         : {identity.Desktop}");

        Console.WriteLine();
        Console.WriteLine("=== terminal sessions (WTSEnumerateSessions) ===");
        var console = Native.ActiveConsoleSessionId();
        try
        {
            foreach (var session in Native.EnumerateSessions())
            {
                var marker = session.SessionId == console ? " <- active console" : "";
                var candidate = session.IsInteractiveCandidate ? "interactive-candidate" : "not-a-candidate";
                Console.WriteLine(
                    $"  {session.SessionId,3}  {session.WinStationName,-14} {session.State,-13} " +
                    $"{session.DomainName}\\{session.UserName,-16} {candidate}{marker}");
            }

            SpikeLog.Write("preflight.sessions", "session enumeration succeeded", new
            {
                active_console = console,
                sessions = Native.EnumerateSessions().Select(s => new
                {
                    s.SessionId, s.WinStationName, State = s.State.ToString(),
                    s.UserName, s.DomainName, s.IsInteractiveCandidate,
                }),
            });
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            Console.WriteLine($"  FAILED: {ex.Message}");
            SpikeLog.WriteError("preflight.sessions.failed", "WTSEnumerateSessions", ex);
        }

        Console.WriteLine();
        Console.WriteLine("=== privileged session mechanisms ===");
        var (ok, error) = Native.TryQueryUserToken(console, out var token);
        if (ok)
        {
            TokenInfo.CloseHandle(token);
        }

        var interpretation = ok
            ? "SUCCEEDED — caller holds SE_TCB_NAME (this is LocalSystem)"
            : SessionLauncher.Explain(error);
        Console.WriteLine($"  WTSQueryUserToken({console}) : {(ok ? "ok" : "failed")} — {interpretation}");
        SpikeLog.Write("preflight.wts_query_user_token", interpretation, new
        {
            session = console,
            ok,
            win32 = error,
            expected_unelevated = SessionLauncher.ErrorPrivilegeNotHeld,
        });

        Console.WriteLine();
        Console.WriteLine("=== spike service ===");
        var installed = ServiceState();
        Console.WriteLine($"  {SpikePaths.ServiceName}: {installed}");
        SpikeLog.Write("preflight.service_state", installed, new { service = SpikePaths.ServiceName });

        Console.WriteLine();
        Console.WriteLine("=== paths ===");
        Console.WriteLine($"  root      : {SpikePaths.Root}");
        Console.WriteLine($"  binaries  : {SpikePaths.BinDir}");
        Console.WriteLine($"  companion : {SpikePaths.CompanionExe} " +
                          $"({(File.Exists(SpikePaths.CompanionExe) ? "present" : "MISSING")})");

        return ok ? 0 : 0; // Neither outcome is a probe failure; both are findings.
    }

    /// <summary>
    /// Read via <c>sc.exe query</c> rather than ServiceController so the probe stays dependency
    /// free and works identically when the service was never installed.
    /// </summary>
    private static string ServiceState()
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo("sc.exe", $"query {SpikePaths.ServiceName}")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });

            if (process is null)
            {
                return "unknown (could not run sc.exe)";
            }

            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(5000);

            if (process.ExitCode != 0)
            {
                return "not installed";
            }

            var stateLine = output
                .Split('\n')
                .FirstOrDefault(l => l.Contains("STATE", StringComparison.OrdinalIgnoreCase));
            return stateLine?.Trim() ?? "installed (state unknown)";
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return $"unknown ({ex.Message})";
        }
    }
}
