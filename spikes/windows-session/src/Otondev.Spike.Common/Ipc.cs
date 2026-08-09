using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace Otondev.Spike.Common;

/// <summary>
/// The supervisor's local IPC endpoint.
///
/// S17's exit criterion is "IPC ACLs hold against an unauthorized local caller", and the
/// design says the service "never ... accepts unauthenticated IPC". Local named pipes give
/// three separate mechanisms, and the spike exercises all three because each one fails
/// differently:
///
///   1. **Discretionary ACL on the pipe.** An unauthorized caller is refused by the kernel at
///      connect time and never reaches a byte of our code. This is the strongest layer.
///   2. **Server verifies the client.** After connect, the server reads the client's SID from
///      the impersonation token and matches an allow-list. This catches the case where the
///      ACL is right but too broad.
///   3. **Client verifies the server.** The client reads the *pipe object's owner SID* before
///      sending anything. Without it, any local process can create `\\.\pipe\ourname` first
///      and harvest whatever the companion sends — a named-pipe squatting attack that an
///      ACL on our own pipe does nothing to prevent, because our pipe never gets created.
///
/// Layer 3 is the one that is usually missing.
/// </summary>
public static class Ipc
{
    public const string PipeName = "otondev-spike-supervisor";

    public sealed record Message(string Op, string Id, string? Payload);

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static string Encode(Message message) => JsonSerializer.Serialize(message, Json);

    public static Message Decode(string line) =>
        JsonSerializer.Deserialize<Message>(line, Json)
        ?? throw new InvalidDataException("empty IPC frame");

    /// <summary>
    /// A pipe ACL that grants exactly the listed principals and nobody else.
    ///
    /// No Everyone entry, no Authenticated Users entry, and — deliberately — no inherited
    /// default. `PipeSecurity` starts empty, so anything not granted here is denied by the
    /// absence of a grant rather than by a deny ACE that a later grant could override.
    /// </summary>
    public static PipeSecurity RestrictTo(params SecurityIdentifier[] allowed)
    {
        var security = new PipeSecurity();
        // The owner must be able to administer its own endpoint or it cannot recreate it.
        security.SetOwner(WindowsIdentity.GetCurrent().User!);
        foreach (var sid in allowed)
        {
            security.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        }
        return security;
    }

    public static NamedPipeServerStream CreateServer(
        PipeSecurity security, string? pipeName = null, int maxInstances = 4) =>
        NamedPipeServerStreamAcl.Create(
            pipeName ?? PipeName,
            PipeDirection.InOut,
            maxInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            inBufferSize: 4096,
            outBufferSize: 4096,
            pipeSecurity: security);

    /// <summary>
    /// Layer 2: who is on the other end?
    /// </summary>
    public static SecurityIdentifier? ClientSid(NamedPipeServerStream server)
    {
        SecurityIdentifier? sid = null;
        server.RunAsClient(() =>
        {
            using var identity = WindowsIdentity.GetCurrent();
            sid = identity.User;
        });
        return sid;
    }

    /// <summary>
    /// Layer 3: who owns the pipe we are about to trust?
    ///
    /// Returns null when the owner cannot be read, and a caller that gets null must refuse to
    /// connect. "Could not verify" and "verified" are not the same answer, and collapsing
    /// them is how this check stops working.
    /// </summary>
    public static SecurityIdentifier? PipeOwnerSid(string pipeName)
    {
        try
        {
            var info = new FileInfo($@"\\.\pipe\{pipeName}");
            var owner = info.GetAccessControl().GetOwner(typeof(SecurityIdentifier));
            return owner as SecurityIdentifier;
        }
        catch (Exception)
        {
            return null;
        }
    }

    public static async Task WriteLineAsync(Stream stream, Message message, CancellationToken ct)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(Encode(message) + "\n");
        await stream.WriteAsync(bytes, ct).ConfigureAwait(false);
        await stream.FlushAsync(ct).ConfigureAwait(false);
    }

    public static async Task<Message?> ReadLineAsync(Stream stream, CancellationToken ct)
    {
        var buffer = new List<byte>(256);
        var one = new byte[1];
        while (true)
        {
            var read = await stream.ReadAsync(one, ct).ConfigureAwait(false);
            if (read == 0) return buffer.Count == 0 ? null : Decode(System.Text.Encoding.UTF8.GetString(buffer.ToArray()));
            if (one[0] == (byte)'\n') return Decode(System.Text.Encoding.UTF8.GetString(buffer.ToArray()));
            buffer.Add(one[0]);
            if (buffer.Count > 64 * 1024) throw new InvalidDataException("IPC frame exceeds 64 KiB");
        }
    }
}
