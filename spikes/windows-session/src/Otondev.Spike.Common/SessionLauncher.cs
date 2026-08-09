using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Otondev.Spike.Common;

/// <summary>
/// The session-0 → interactive-session launch. This is the mechanism the whole presence design
/// rests on: a non-interactive service in session 0 starting a companion that owns a real
/// window station and desktop.
///
/// Two things here are load-bearing and easy to get subtly wrong:
///
/// 1. <c>lpDesktop</c> must be <c>winsta0\default</c>. Left null the child inherits the
///    service's own window station (<c>Service-0x0-3e7$</c>), the process starts, every call
///    "succeeds", and no pixel is ever drawn. That failure mode looks like success from the
///    service's side, which is exactly the sort of thing a spike exists to catch.
/// 2. On an administrator account <c>WTSQueryUserToken</c> returns the <i>full</i> token. Using
///    it directly would give an elevated companion and quietly violate the design's
///    least-privilege rule, so the launcher walks to the UAC-linked limited token on purpose.
/// </summary>
public static class SessionLauncher
{
    private const uint MaximumAllowed = 0x02000000;
    private const int CreateUnicodeEnvironment = 0x00000400;
    private const int CreateNoWindow = 0x08000000;
    private const int CreateNewConsole = 0x00000010;

    private const int SecurityImpersonation = 2;
    private const int TokenPrimary = 1;

    public const int ErrorPrivilegeNotHeld = 1314;
    public const int ErrorNoToken = 1008;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(int sessionId, out IntPtr phToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(
        IntPtr hExistingToken, uint dwDesiredAccess, IntPtr lpTokenAttributes,
        int impersonationLevel, int tokenType, out IntPtr phNewToken);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(
        IntPtr hToken, string? lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles,
        int dwCreationFlags, IntPtr lpEnvironment, string? lpCurrentDirectory,
        ref StartupInfo lpStartupInfo, out ProcessInformation lpProcessInformation);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

    /// <summary>
    /// Outcome of a launch attempt. <see cref="Stage"/> matters more than <see cref="Ok"/> for
    /// the write-up: "failed at WTSQueryUserToken with 1314" is a privilege finding, while
    /// "failed at CreateProcessAsUser with 233" is an architecture finding.
    /// </summary>
    public sealed record LaunchResult(
        bool Ok,
        string Stage,
        int Win32Error,
        int Pid,
        string TokenElevationType,
        string TokenIntegrityLevel,
        bool TokenIsElevated,
        bool UsedLinkedToken,
        string UserSid)
    {
        public SafeProcessHandle? Process { get; init; }

        public static LaunchResult Fail(string stage, int error) =>
            new(false, stage, error, 0, "", "", false, false, "");
    }

    /// <summary>
    /// Launch <paramref name="exePath"/> in <paramref name="sessionId"/> as that session's
    /// logged-on user, non-elevated, on the interactive desktop.
    /// </summary>
    /// <param name="showWindow">
    /// Keep the child hidden by default. The reboot/logoff runs otherwise litter the user's
    /// desktop with console windows, and a visible console is not part of what is being tested.
    /// </param>
    public static LaunchResult Launch(int sessionId, string exePath, string arguments, bool showWindow = false)
    {
        if (!WTSQueryUserToken(sessionId, out var userToken))
        {
            return LaunchResult.Fail(nameof(WTSQueryUserToken), Marshal.GetLastWin32Error());
        }

        var effectiveToken = userToken;
        var usedLinked = false;
        var primary = IntPtr.Zero;
        var environment = IntPtr.Zero;

        try
        {
            // Step down to the limited half of a split admin token if there is one.
            var elevationType = TokenInfo.GetElevationType(userToken);
            if (elevationType == TokenInfo.ElevationType.Full)
            {
                try
                {
                    var linked = TokenInfo.GetLinkedToken(userToken);
                    if (linked != IntPtr.Zero)
                    {
                        effectiveToken = linked;
                        usedLinked = true;
                    }
                }
                catch (System.ComponentModel.Win32Exception)
                {
                    // No linked token available; fall through with the original and let the
                    // reported integrity level expose it rather than pretending otherwise.
                }
            }

            if (!DuplicateTokenEx(
                    effectiveToken, MaximumAllowed, IntPtr.Zero,
                    SecurityImpersonation, TokenPrimary, out primary))
            {
                return LaunchResult.Fail(nameof(DuplicateTokenEx), Marshal.GetLastWin32Error());
            }

            var describedElevation = TokenInfo.GetElevationType(primary).ToString();
            var describedIntegrity = TokenInfo.GetIntegrityLevel(primary);
            var describedElevated = TokenInfo.IsElevated(primary);
            var describedSid = TokenInfo.GetUserSid(primary).Value;

            if (!CreateEnvironmentBlock(out environment, primary, false))
            {
                return LaunchResult.Fail(nameof(CreateEnvironmentBlock), Marshal.GetLastWin32Error());
            }

            var startup = new StartupInfo
            {
                cb = Marshal.SizeOf<StartupInfo>(),
                // Load-bearing: without this the child lands on the service's non-interactive
                // window station and can never touch the user's desktop.
                lpDesktop = @"winsta0\default",
            };

            var flags = CreateUnicodeEnvironment | (showWindow ? CreateNewConsole : CreateNoWindow);
            var commandLine = new StringBuilder($"\"{exePath}\" {arguments}");
            var workingDirectory = Path.GetDirectoryName(exePath);

            if (!CreateProcessAsUser(
                    primary, exePath, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                    flags, environment, workingDirectory, ref startup, out var pi))
            {
                return LaunchResult.Fail(nameof(CreateProcessAsUser), Marshal.GetLastWin32Error());
            }

            TokenInfo.CloseHandle(pi.hThread);
            return new LaunchResult(
                true, "launched", 0, pi.dwProcessId,
                describedElevation, describedIntegrity, describedElevated, usedLinked, describedSid)
            {
                Process = new SafeProcessHandle(pi.hProcess, ownsHandle: true),
            };
        }
        finally
        {
            if (environment != IntPtr.Zero)
            {
                DestroyEnvironmentBlock(environment);
            }
            if (primary != IntPtr.Zero)
            {
                TokenInfo.CloseHandle(primary);
            }
            if (usedLinked && effectiveToken != IntPtr.Zero)
            {
                TokenInfo.CloseHandle(effectiveToken);
            }
            TokenInfo.CloseHandle(userToken);
        }
    }

    /// <summary>
    /// Human-readable gloss for the Win32 errors this path actually produces, so the findings
    /// do not have to make the reader look them up.
    /// </summary>
    public static string Explain(int win32Error) => win32Error switch
    {
        0 => "success",
        ErrorNoToken => "ERROR_NO_TOKEN — no user is logged on to that session",
        ErrorPrivilegeNotHeld => "ERROR_PRIVILEGE_NOT_HELD (1314) — caller lacks SE_TCB_NAME; only LocalSystem holds it",
        5 => "ERROR_ACCESS_DENIED (5)",
        233 => "ERROR_PIPE_NOT_CONNECTED (233)",
        2 => "ERROR_FILE_NOT_FOUND (2) — the companion binary path is wrong",
        _ => $"Win32 error {win32Error}",
    };
}
