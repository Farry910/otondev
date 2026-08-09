using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Otondev.Spike.Common;

/// <summary>
/// The cross-session launch: session 0 service -> interactive companion.
///
/// This is the mechanism the whole presence architecture rests on, and it is the one thing
/// that cannot be faked, approximated, or demonstrated from an ordinary shell. The sequence is:
///
///   WTSQueryUserToken(session)      needs SE_TCB_NAME — LocalSystem only
///   -> filter to the limited token  so the companion is NOT administrator
///   -> DuplicateTokenEx(Primary)    CreateProcessAsUser needs a primary token
///   -> CreateEnvironmentBlock       or the companion gets the service's environment, not the user's
///   -> CreateProcessAsUser(lpDesktop = "winsta0\\default")
///
/// Two of those steps are the ones people leave out and then wonder why the process starts
/// but is invisible: without <c>lpDesktop</c> the process lands on the service's
/// non-interactive window station and can never show UI, and without the environment block it
/// runs with the wrong APPDATA/USERPROFILE.
/// </summary>
public static class Launch
{
    private const int TokenDuplicate = 0x0002;
    private const int TokenQuery = 0x0008;
    private const int TokenAssignPrimary = 0x0001;
    private const int TokenAdjustDefault = 0x0080;
    private const int TokenAdjustSessionId = 0x0100;

    private const int SecurityImpersonation = 2;
    private const int TokenPrimary = 1;

    private const int CreateUnicodeEnvironment = 0x00000400;
    private const int CreateNewConsole = 0x00000010;
    private const int CreateNoWindow = 0x08000000;
    private const int CreateBreakawayFromJob = 0x01000000;

    private const int TokenElevationTypeClass = 18;
    private const int TokenLinkedTokenClass = 19;
    private const int TokenIntegrityLevelClass = 25;

    public enum ElevationType
    {
        Default = 1,

        /// <summary>Admin account, UAC on: this token is the *filtered* one. What we want.</summary>
        Full = 2,

        /// <summary>Admin account, UAC on: this token is elevated. What we must refuse.</summary>
        Limited = 3,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        public bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize;
        public int dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(
        IntPtr existing, int desiredAccess, IntPtr attributes,
        int impersonationLevel, int tokenType, out IntPtr newToken);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(
        IntPtr token, string? applicationName, string? commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        int creationFlags, IntPtr environment, string? currentDirectory,
        ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        IntPtr token, int infoClass, IntPtr info, int length, out int returnLength);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr environment);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public sealed record LaunchResult(int ProcessId, bool CompanionIsElevated, string TokenSource);

    /// <summary>
    /// Read the elevation type of a token. The companion's must not be <see cref="ElevationType.Limited"/>
    /// — which, confusingly, is the name Windows gives the *elevated* token's type.
    /// </summary>
    public static ElevationType GetElevationType(IntPtr token)
    {
        var buffer = Marshal.AllocHGlobal(sizeof(int));
        try
        {
            if (!GetTokenInformation(token, TokenElevationTypeClass, buffer, sizeof(int), out _))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation(TokenElevationType)");
            }
            return (ElevationType)Marshal.ReadInt32(buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>
    /// If <paramref name="token"/> is an elevated admin token, return its linked limited token.
    /// Otherwise return <see cref="IntPtr.Zero"/>.
    ///
    /// The card requires the companion to run non-administrator. Relying on
    /// <c>WTSQueryUserToken</c> to hand back the filtered token by luck is not the same as
    /// enforcing it, so the service checks and downgrades explicitly.
    /// </summary>
    public static IntPtr TryGetLinkedLimitedToken(IntPtr token)
    {
        if (GetElevationType(token) != ElevationType.Limited)
        {
            return IntPtr.Zero;
        }

        var buffer = Marshal.AllocHGlobal(IntPtr.Size);
        try
        {
            if (!GetTokenInformation(token, TokenLinkedTokenClass, buffer, IntPtr.Size, out _))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetTokenInformation(TokenLinkedToken)");
            }
            return Marshal.ReadIntPtr(buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>
    /// Launch <paramref name="commandLine"/> in <paramref name="sessionId"/> as the logged-on user.
    /// Throws <see cref="Win32Exception"/> with the real Win32 error on any step — the error code
    /// is the finding when this fails.
    /// </summary>
    public static LaunchResult AsSessionUser(int sessionId, string commandLine, string? workingDirectory = null)
    {
        var (ok, error) = Native.TryQueryUserToken(sessionId, out var userToken);
        if (!ok)
        {
            throw new Win32Exception(error, $"WTSQueryUserToken(session {sessionId})");
        }

        var tokenSource = "WTSQueryUserToken";
        var environment = IntPtr.Zero;
        var primary = IntPtr.Zero;
        var limited = IntPtr.Zero;

        try
        {
            var effective = userToken;

            limited = TryGetLinkedLimitedToken(userToken);
            if (limited != IntPtr.Zero)
            {
                effective = limited;
                tokenSource = "WTSQueryUserToken -> TokenLinkedToken (de-elevated)";
            }

            var elevationType = GetElevationType(effective);
            if (elevationType == ElevationType.Limited)
            {
                throw new InvalidOperationException(
                    "refusing to launch the companion with an elevated token; " +
                    "the card requires a non-administrator companion");
            }

            const int access = TokenAssignPrimary | TokenDuplicate | TokenQuery
                | TokenAdjustDefault | TokenAdjustSessionId;

            if (!DuplicateTokenEx(effective, access, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primary))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateTokenEx");
            }

            if (!CreateEnvironmentBlock(out environment, primary, false))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateEnvironmentBlock");
            }

            var startup = new StartupInfo
            {
                cb = Marshal.SizeOf<StartupInfo>(),
                // Without this the process starts on the service's window station and can never show UI.
                lpDesktop = @"winsta0\default",
            };

            var flags = CreateUnicodeEnvironment | CreateNewConsole | CreateBreakawayFromJob;

            if (!CreateProcessAsUser(
                    primary, null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                    flags, environment, workingDirectory, ref startup, out var info))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser");
            }

            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);

            return new LaunchResult(info.dwProcessId, elevationType == ElevationType.Limited, tokenSource);
        }
        finally
        {
            if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment);
            if (primary != IntPtr.Zero) CloseHandle(primary);
            if (limited != IntPtr.Zero) CloseHandle(limited);
            CloseHandle(userToken);
        }
    }

    /// <summary>
    /// The SID of the user logged into <paramref name="sessionId"/>, if we are privileged enough
    /// to ask. The supervisor needs this before it creates its pipe, so that the ACL names the
    /// companion's account specifically rather than a broad group.
    /// </summary>
    public static (System.Security.Principal.SecurityIdentifier? Sid, int Win32Error) TrySessionUserSid(int sessionId)
    {
        var (ok, error) = Native.TryQueryUserToken(sessionId, out var token);
        if (!ok)
        {
            return (null, error);
        }

        try
        {
            using var identity = new System.Security.Principal.WindowsIdentity(token);
            return (identity.User, 0);
        }
        finally
        {
            CloseHandle(token);
        }
    }

    /// <summary>Integrity level of the current process, as a readable label.</summary>
    public static string CurrentIntegrityLevel()
    {
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        GetTokenInformation(identity.Token, TokenIntegrityLevelClass, IntPtr.Zero, 0, out var size);
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!GetTokenInformation(identity.Token, TokenIntegrityLevelClass, buffer, size, out _))
            {
                return "unknown";
            }
            // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; } }
            var sidPtr = Marshal.ReadIntPtr(buffer);
            var sid = new System.Security.Principal.SecurityIdentifier(sidPtr);
            return sid.Value switch
            {
                "S-1-16-0" => "untrusted",
                "S-1-16-4096" => "low",
                "S-1-16-8192" => "medium",
                "S-1-16-8448" => "medium-plus",
                "S-1-16-12288" => "high",
                "S-1-16-16384" => "system",
                _ => sid.Value,
            };
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
