using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Otondev.Spike.Common;

/// <summary>
/// The Windows session mechanisms the design depends on
/// (secure-box-and-supervision.md "Windows session architecture").
///
/// Two of these need privileges an interactive process does not have:
/// <see cref="WtsQueryUserToken"/> needs SE_TCB_NAME, which only LocalSystem holds, and
/// <see cref="CreateProcessAsUser"/> needs the token that call produces. That is not an
/// accident of this spike — it is precisely why the design has a session-0 service at all,
/// and it is the reason the cross-session launch cannot be demonstrated from an ordinary
/// shell no matter how the spike is written.
/// </summary>
public static class Native
{
    public const int WtsCurrentServer = 0;

    public enum WtsConnectState
    {
        Active,
        Connected,
        ConnectQuery,
        Shadow,
        Disconnected,
        Idle,
        Listen,
        Reset,
        Down,
        Init,
    }

    public enum WtsInfoClass
    {
        InitialProgram = 0,
        ApplicationName = 1,
        WorkingDirectory = 2,
        OemId = 3,
        SessionId = 4,
        UserName = 5,
        WinStationName = 6,
        DomainName = 7,
        ConnectState = 8,
        ClientBuildNumber = 9,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WtsSessionInfo
    {
        public int SessionId;
        [MarshalAs(UnmanagedType.LPWStr)] public string WinStationName;
        public WtsConnectState State;
    }

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern int WTSEnumerateSessions(
        IntPtr hServer, int reserved, int version, out IntPtr ppSessionInfo, out int pCount);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr pMemory);

    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool WTSQuerySessionInformation(
        IntPtr hServer, int sessionId, WtsInfoClass infoClass, out IntPtr buffer, out int bytesReturned);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(int sessionId, out IntPtr phToken);

    [DllImport("kernel32.dll")]
    private static extern int WTSGetActiveConsoleSessionId();

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(
        IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, int length, out int returnLength);

    public sealed record SessionInfo(
        int SessionId,
        string WinStationName,
        WtsConnectState State,
        string UserName,
        string DomainName)
    {
        /// <summary>
        /// A session the companion could actually live in: it has a logged-on user and a
        /// window station. Session 0 is excluded by construction — that is the whole problem
        /// this architecture exists to solve.
        /// </summary>
        public bool IsInteractiveCandidate =>
            SessionId != 0
            && !string.IsNullOrEmpty(UserName)
            && State is WtsConnectState.Active or WtsConnectState.Connected or WtsConnectState.Disconnected;
    }

    /// <summary>Enumerate terminal sessions. Works without elevation.</summary>
    public static IReadOnlyList<SessionInfo> EnumerateSessions()
    {
        if (WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var buffer, out var count) == 0)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "WTSEnumerateSessions failed");
        }

        try
        {
            var results = new List<SessionInfo>(count);
            var size = Marshal.SizeOf<WtsSessionInfo>();
            for (var i = 0; i < count; i++)
            {
                var element = Marshal.PtrToStructure<WtsSessionInfo>(buffer + (i * size));
                results.Add(new SessionInfo(
                    element.SessionId,
                    element.WinStationName,
                    element.State,
                    QueryString(element.SessionId, WtsInfoClass.UserName),
                    QueryString(element.SessionId, WtsInfoClass.DomainName)));
            }
            return results;
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
    }

    public static int ActiveConsoleSessionId() => WTSGetActiveConsoleSessionId();

    private static string QueryString(int sessionId, WtsInfoClass infoClass)
    {
        if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, infoClass, out var buffer, out _))
        {
            return string.Empty;
        }
        try
        {
            return Marshal.PtrToStringUni(buffer) ?? string.Empty;
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
    }

    /// <summary>
    /// Attempt to obtain the user token for <paramref name="sessionId"/>.
    ///
    /// Returns the Win32 error rather than throwing, because "which error" is itself the
    /// finding: ERROR_PRIVILEGE_NOT_HELD (1314) is the expected, informative failure from an
    /// unelevated caller and means the mechanism is intact but the privilege is not held.
    /// </summary>
    public static (bool Ok, int Win32Error) TryQueryUserToken(int sessionId, out IntPtr token)
    {
        if (WTSQueryUserToken(sessionId, out token))
        {
            return (true, 0);
        }
        token = IntPtr.Zero;
        return (false, Marshal.GetLastWin32Error());
    }

    private const int TokenElevation = 20;

    /// <summary>Is the current process token elevated? The companion must answer "no".</summary>
    public static bool IsCurrentProcessElevated()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var handle = Marshal.AllocHGlobal(sizeof(int));
        try
        {
            if (!GetTokenInformation(identity.Token, TokenElevation, handle, sizeof(int), out _))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation(TokenElevation)");
            }
            return Marshal.ReadInt32(handle) != 0;
        }
        finally
        {
            Marshal.FreeHGlobal(handle);
        }
    }

    public static bool IsCurrentProcessAdministrator()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }
}
