using System.IO.Pipes;
using System.Security.Principal;

namespace Otondev.Spike.Common;

/// <summary>
/// The client half of the mutually authenticated channel.
///
/// "Mutually authenticated" is the phrase in both the S17 criterion and the design doc, and it
/// is the half that gets skipped. A pipe ACL authenticates the *client to the server*. It does
/// nothing to authenticate the server to the client, because the attack that matters — a local
/// process creating <c>\\.\pipe\otondev-spike-supervisor</c> before the real supervisor does —
/// means the real pipe never exists and its ACL never runs.
/// </summary>
public static class IpcClient
{
    public sealed record ConnectOutcome(
        bool Connected,
        string Reason,
        SecurityIdentifier? ObservedOwner,
        NamedPipeClientStream? Stream);

    /// <summary>
    /// Connect only if the pipe is owned by one of <paramref name="trustedOwners"/>.
    ///
    /// Order matters: the owner is read *before* the stream is used for anything, and a null
    /// owner is a refusal rather than a pass. Both are deliberate.
    /// </summary>
    public static ConnectOutcome ConnectVerified(
        string pipeName,
        IReadOnlyCollection<SecurityIdentifier> trustedOwners,
        int timeoutMs = 5000)
    {
        var owner = Ipc.PipeOwnerSid(pipeName);
        if (owner is null)
        {
            return new ConnectOutcome(false, "pipe owner could not be read; refusing to connect", null, null);
        }

        if (!trustedOwners.Contains(owner))
        {
            return new ConnectOutcome(
                false,
                $"pipe owned by {owner.Value}, which is not a trusted supervisor identity; refusing to connect",
                owner,
                null);
        }

        var stream = new NamedPipeClientStream(
            ".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous,
            // The server must not be able to turn around and act as us.
            TokenImpersonationLevel.Identification);

        try
        {
            stream.Connect(timeoutMs);
        }
        catch (Exception ex)
        {
            stream.Dispose();
            return new ConnectOutcome(false, $"{ex.GetType().Name}: {ex.Message}", owner, null);
        }

        return new ConnectOutcome(true, $"connected to pipe owned by {Describe(owner)}", owner, stream);
    }

    public static string Describe(SecurityIdentifier sid)
    {
        try
        {
            return $"{sid.Translate(typeof(NTAccount))} ({sid.Value})";
        }
        catch (Exception)
        {
            return sid.Value;
        }
    }

    public static SecurityIdentifier WellKnown(WellKnownSidType type) => new(type, null);
}
