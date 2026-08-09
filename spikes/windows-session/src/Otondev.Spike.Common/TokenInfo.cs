using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Otondev.Spike.Common;

/// <summary>
/// Token and desktop introspection.
///
/// Exit criterion 4 ("the companion runs non-administrator") cannot be evidenced by asserting
/// it in a config file — it has to be read back off the live process token. This type is how
/// the companion proves what it actually is, and how the service proves what it actually
/// launched. Integrity level is reported alongside elevation because they answer different
/// questions: a non-elevated process on an admin account still carries the Administrators
/// group as deny-only, and only the integrity level and group attributes show that.
/// </summary>
public static class TokenInfo
{
    private const int TokenUser = 1;
    private const int TokenElevationType = 18;
    private const int TokenLinkedToken = 19;
    private const int TokenElevation = 20;
    private const int TokenIntegrityLevel = 25;

    private const int UoiName = 2;

    public enum ElevationType
    {
        Unknown = 0,
        Default = 1,
        Full = 2,
        Limited = 3,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(
        IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, int length, out int returnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetProcessWindowStation();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetThreadDesktop(uint threadId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformation(
        IntPtr hObj, int index, IntPtr pvInfo, int nLength, out int lpnLengthNeeded);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);

    /// <summary>Raw <c>GetTokenInformation</c>, sized in two passes.</summary>
    private static IntPtr Query(IntPtr token, int infoClass, out int size)
    {
        GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out size);
        var error = Marshal.GetLastWin32Error();
        if (size == 0)
        {
            throw new Win32Exception(error, $"GetTokenInformation(class {infoClass}) size probe failed");
        }

        var buffer = Marshal.AllocHGlobal(size);
        if (!GetTokenInformation(token, infoClass, buffer, size, out size))
        {
            var inner = Marshal.GetLastWin32Error();
            Marshal.FreeHGlobal(buffer);
            throw new Win32Exception(inner, $"GetTokenInformation(class {infoClass}) failed");
        }
        return buffer;
    }

    public static bool IsElevated(IntPtr token)
    {
        var buffer = Query(token, TokenElevation, out _);
        try
        {
            return Marshal.ReadInt32(buffer) != 0;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static ElevationType GetElevationType(IntPtr token)
    {
        var buffer = Query(token, TokenElevationType, out _);
        try
        {
            return (ElevationType)Marshal.ReadInt32(buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>
    /// Windows mandatory integrity level as a name. "Medium" is what a normal interactive
    /// process gets and is what the companion must report; "High" would mean the launch path
    /// handed it an elevated token and the design's least-privilege claim is broken.
    /// </summary>
    public static string GetIntegrityLevel(IntPtr token)
    {
        var buffer = Query(token, TokenIntegrityLevel, out _);
        try
        {
            var label = Marshal.PtrToStructure<SidAndAttributes>(buffer);
            var countPtr = GetSidSubAuthorityCount(label.Sid);
            var count = Marshal.ReadByte(countPtr);
            var ridPtr = GetSidSubAuthority(label.Sid, (uint)(count - 1));
            var rid = (uint)Marshal.ReadInt32(ridPtr);
            return rid switch
            {
                < 0x1000 => $"Untrusted(0x{rid:x})",
                < 0x2000 => $"Low(0x{rid:x})",
                < 0x3000 => $"Medium(0x{rid:x})",
                < 0x4000 => $"High(0x{rid:x})",
                _ => $"System(0x{rid:x})",
            };
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static SecurityIdentifier GetUserSid(IntPtr token)
    {
        var buffer = Query(token, TokenUser, out _);
        try
        {
            var user = Marshal.PtrToStructure<SidAndAttributes>(buffer);
            return new SecurityIdentifier(user.Sid);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>
    /// The UAC-linked token, if the token is one half of a split pair.
    ///
    /// This is the difference between "the companion happens to be non-admin because the
    /// logged-on user is non-admin" and "the launch path guarantees non-admin". On an
    /// administrator account, <c>WTSQueryUserToken</c> hands back the <i>full</i> token; the
    /// service has to walk to the limited half deliberately. Caller owns the returned handle.
    /// </summary>
    public static IntPtr GetLinkedToken(IntPtr token)
    {
        var buffer = Query(token, TokenLinkedToken, out _);
        try
        {
            return Marshal.ReadIntPtr(buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>Window station name of the calling process, e.g. <c>WinSta0</c> or <c>Service-0x0-3e7$</c>.</summary>
    public static string CurrentWindowStationName() => UserObjectName(GetProcessWindowStation());

    /// <summary>Desktop name of the calling thread, e.g. <c>Default</c>.</summary>
    public static string CurrentDesktopName() => UserObjectName(GetThreadDesktop(GetCurrentThreadId()));

    private static string UserObjectName(IntPtr handle)
    {
        if (handle == IntPtr.Zero)
        {
            return "<none>";
        }

        GetUserObjectInformation(handle, UoiName, IntPtr.Zero, 0, out var needed);
        if (needed <= 0)
        {
            return "<unknown>";
        }

        var buffer = Marshal.AllocHGlobal(needed);
        try
        {
            return GetUserObjectInformation(handle, UoiName, buffer, needed, out _)
                ? Marshal.PtrToStringUni(buffer) ?? "<unknown>"
                : "<unknown>";
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>Everything the spike wants to record about "what am I running as".</summary>
    public sealed record Snapshot(
        string UserName,
        string UserSid,
        bool IsElevated,
        bool IsAdministrator,
        string ElevationType,
        string IntegrityLevel,
        string WindowStation,
        string Desktop,
        int SessionId);

    public static Snapshot Describe()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var token = identity.Token;
        return new Snapshot(
            identity.Name,
            identity.User?.Value ?? "<none>",
            IsElevated(token),
            new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator),
            GetElevationType(token).ToString(),
            GetIntegrityLevel(token),
            CurrentWindowStationName(),
            CurrentDesktopName(),
            System.Diagnostics.Process.GetCurrentProcess().SessionId);
    }
}
