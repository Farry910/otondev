using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Otondev.Spike.Common;

/// <summary>
/// Mutual authentication for the local IPC channel (exit criterion 5).
///
/// "Mutual" is doing real work here, because the two directions fail differently:
///
/// <b>Server authenticating client.</b> The DACL alone is not enough. It can only express
/// "this user SID may open the pipe", and on a single-user presence desktop <i>every</i>
/// process the user runs — including anything that talks them into running it — satisfies
/// that. So the server also resolves the caller's PID off the pipe and checks the image it is
/// running from. A DACL keeps other users out; the image check keeps the user's own
/// unrelated processes out.
///
/// <b>Client authenticating server.</b> Pipe names are a machine-global namespace with no
/// reservation, so an ordinary unprivileged process can create <c>\\.\pipe\otondev-*</c>
/// first and collect whatever the companion sends. The companion therefore reads the pipe
/// object's <i>owner</i> SID and refuses anything not owned by the identity that launched it.
/// This is the direction people usually skip, and it is the one that leaks.
/// </summary>
public static class PipeAuth
{
    private const int SeKernelObject = 6;
    private const int OwnerSecurityInformation = 0x00000001;
    private const int ProcessQueryLimitedInformation = 0x1000;
    private const int TokenQuery = 0x0008;

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int desiredAccess, bool inheritHandle, int processId);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, int desiredAccess, out IntPtr token);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(
        IntPtr process, int flags, System.Text.StringBuilder exeName, ref int size);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern int GetSecurityInfo(
        IntPtr handle, int objectType, int securityInfo,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr securityDescriptor);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr mem);

    public sealed record PeerIdentity(int Pid, string UserSid, string UserName, string ImagePath);

    /// <summary>
    /// DACL for the supervisor pipe: LocalSystem and Administrators for operation and recovery,
    /// the companion's own user for the channel itself, and — critically — <b>nothing else</b>.
    /// The rule set is built from scratch rather than modified from a default, so there is no
    /// inherited "Authenticated Users" ACE hiding underneath.
    /// </summary>
    public static PipeSecurity BuildServerAcl(SecurityIdentifier companionUser)
    {
        var security = new PipeSecurity();
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var self = WindowsIdentity.GetCurrent().User ?? system;

        security.SetOwner(self);
        security.AddAccessRule(new PipeAccessRule(system, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(administrators, PipeAccessRights.FullControl, AccessControlType.Allow));

        // The supervisor's own identity needs FILE_CREATE_PIPE_INSTANCE to add instances after
        // the first, and a DACL set from scratch does not grant it implicitly — not even to the
        // object's owner. Under LocalSystem this is already covered by the SYSTEM ACE above and
        // changes nothing; it only matters when the supervisor runs as an ordinary user, where
        // omitting it makes the *second* connection fail with ACCESS_DENIED long after the first
        // one worked.
        security.AddAccessRule(new PipeAccessRule(self, PipeAccessRights.FullControl, AccessControlType.Allow));

        security.AddAccessRule(new PipeAccessRule(
            companionUser,
            PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize,
            AccessControlType.Allow));
        return security;
    }

    public const int MaxServerInstances = 4;

    /// <summary>
    /// Create a listening pipe instance.
    /// </summary>
    /// <param name="first">
    /// Pass true for the very first instance the supervisor creates, which adds
    /// <see cref="PipeOptions.FirstPipeInstance"/>. That flag is deliberate: it turns name
    /// squatting into a loud failure at creation time instead of a silent handover of the
    /// channel. A sharing violation here is a security event, not something to retry.
    /// Subsequent instances must not pass it — the name legitimately exists by then.
    /// </param>
    /// <remarks>
    /// Several instances rather than one, so that a caller who connects and fails
    /// authorisation cannot hold the only slot and keep the real companion off the channel.
    /// Rejection has to be cheap for the rejecter and free for everyone else.
    /// </remarks>
    public static NamedPipeServerStream CreateServer(string pipeName, PipeSecurity security, bool first) =>
        NamedPipeServerStreamAcl.Create(
            pipeName,
            PipeDirection.InOut,
            MaxServerInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | (first ? PipeOptions.FirstPipeInstance : PipeOptions.None),
            inBufferSize: 8192,
            outBufferSize: 8192,
            security);

    /// <summary>
    /// Who is on the other end? Resolved from the kernel's view of the pipe, not from anything
    /// the caller claims about itself in the protocol.
    /// </summary>
    public static PeerIdentity IdentifyClient(NamedPipeServerStream server)
    {
        var handle = server.SafePipeHandle.DangerousGetHandle();
        if (!GetNamedPipeClientProcessId(handle, out var clientPid))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "GetNamedPipeClientProcessId failed");
        }

        var process = OpenProcess(ProcessQueryLimitedInformation, false, (int)clientPid);
        if (process == IntPtr.Zero)
        {
            // Caller already exited, or we lack rights to look at it. Either way it is not
            // something to admit onto the channel.
            return new PeerIdentity((int)clientPid, "<unavailable>", "<unavailable>", "<unavailable>");
        }

        var token = IntPtr.Zero;
        try
        {
            var imagePath = "<unavailable>";
            var buffer = new System.Text.StringBuilder(1024);
            var size = buffer.Capacity;
            if (QueryFullProcessImageName(process, 0, buffer, ref size))
            {
                imagePath = buffer.ToString();
            }

            if (!OpenProcessToken(process, TokenQuery, out token))
            {
                return new PeerIdentity((int)clientPid, "<unavailable>", "<unavailable>", imagePath);
            }

            var sid = TokenInfo.GetUserSid(token);
            var name = TryTranslate(sid);
            return new PeerIdentity((int)clientPid, sid.Value, name, imagePath);
        }
        finally
        {
            if (token != IntPtr.Zero)
            {
                TokenInfo.CloseHandle(token);
            }
            TokenInfo.CloseHandle(process);
        }
    }

    /// <summary>
    /// Owner SID of a pipe object. The companion uses this to decide whether the thing it just
    /// connected to is really its supervisor.
    /// </summary>
    public static SecurityIdentifier GetPipeOwner(SafePipeHandle handle)
    {
        var status = GetSecurityInfo(
            handle.DangerousGetHandle(), SeKernelObject, OwnerSecurityInformation,
            out var owner, out _, out _, out _, out var descriptor);

        if (status != 0)
        {
            throw new Win32Exception(status, "GetSecurityInfo(OWNER_SECURITY_INFORMATION) failed");
        }

        try
        {
            return new SecurityIdentifier(owner);
        }
        finally
        {
            if (descriptor != IntPtr.Zero)
            {
                LocalFree(descriptor);
            }
        }
    }

    private static string TryTranslate(SecurityIdentifier sid)
    {
        try
        {
            return ((NTAccount)sid.Translate(typeof(NTAccount))).Value;
        }
        catch (IdentityNotMappedException)
        {
            return sid.Value;
        }
        catch (SystemException)
        {
            return sid.Value;
        }
    }

    /// <summary>Result of an authorisation decision, kept as data so it can be logged verbatim.</summary>
    public sealed record AuthDecision(bool Allowed, string Reason, PeerIdentity Peer);

    /// <summary>
    /// Server-side policy. Both conditions must hold; either one alone is insufficient for the
    /// reasons in the type comment.
    /// </summary>
    public static AuthDecision Authorize(
        PeerIdentity peer, SecurityIdentifier expectedUser, string expectedImagePath)
    {
        if (!string.Equals(peer.UserSid, expectedUser.Value, StringComparison.OrdinalIgnoreCase))
        {
            return new AuthDecision(false, $"user SID {peer.UserSid} is not the expected {expectedUser.Value}", peer);
        }

        var expected = NormalizePath(expectedImagePath);
        var actual = NormalizePath(peer.ImagePath);
        if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
        {
            return new AuthDecision(false, $"image {peer.ImagePath} is not the expected {expectedImagePath}", peer);
        }

        return new AuthDecision(true, "user SID and image path both match", peer);
    }

    private static string NormalizePath(string path)
    {
        try
        {
            return Path.GetFullPath(path);
        }
        catch (ArgumentException)
        {
            return path;
        }
        catch (NotSupportedException)
        {
            return path;
        }
    }
}
