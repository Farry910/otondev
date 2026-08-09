using System.Security.AccessControl;
using System.Security.Principal;
using Otondev.Spike.Common;

namespace Otondev.Spike.Companion;

/// <summary>
/// The companion's local emergency stop.
///
/// S16 asks for a stop "that works with the network and control plane down", and that rules out
/// most of the obvious designs: not an HTTP endpoint, not a control-plane poll, not a message
/// that has to arrive over the supervisor pipe — the supervisor may be the thing that is gone.
/// A named kernel event in the session's own namespace needs nothing but the local kernel, is
/// ACLed to the companion's own account, and is signalled by an operator tool running on the
/// same desktop as the human who wants the agent to stop.
///
/// <c>Local\</c> rather than <c>Global\</c> is deliberate: the global namespace needs
/// SeCreateGlobalPrivilege, which a least-privilege companion must not have.
/// </summary>
public sealed class LocalStop : IDisposable
{
    public const string EventName = @"Local\otondev-spike-companion-stop";

    private readonly EventWaitHandle _handle;
    private readonly RegisteredWaitHandle _registration;

    private LocalStop(EventWaitHandle handle, RegisteredWaitHandle registration)
    {
        _handle = handle;
        _registration = registration;
    }

    public static LocalStop Arm(string component, CancellationTokenSource cts)
    {
        var security = new EventWaitHandleSecurity();
        var self = WindowsIdentity.GetCurrent().User!;
        security.AddAccessRule(new EventWaitHandleAccessRule(
            self,
            EventWaitHandleRights.FullControl,
            AccessControlType.Allow));

        var handle = EventWaitHandleAcl.Create(
            initialState: false,
            EventResetMode.ManualReset,
            EventName,
            out var createdNew,
            security);

        var registration = ThreadPool.RegisterWaitForSingleObject(
            handle,
            (_, _) =>
            {
                Evidence.Record(component, "local-emergency-stop", Outcome.Pass,
                    "stop signalled through the local kernel event; no network or control plane involved",
                    criterion: "local emergency stop that works with the network and control plane down");
                cts.Cancel();
            },
            state: null,
            timeout: Timeout.InfiniteTimeSpan,
            executeOnlyOnce: true);

        Evidence.Record(component, "local-emergency-stop-armed", Outcome.Info,
            $"{EventName} ({(createdNew ? "created" : "attached to existing")}), ACL grants only {self.Value}");

        return new LocalStop(handle, registration);
    }

    /// <summary>Signal the stop. Used by the operator tool, and by the test harness.</summary>
    public static bool Signal()
    {
        try
        {
            // EventWaitHandleAcl, not EventWaitHandle: in .NET 10 the two-argument
            // EventWaitHandle.OpenExisting overload takes NamedWaitHandleOptions, and the
            // rights-based one lives on the Acl helper.
            using var handle = EventWaitHandleAcl.OpenExisting(EventName, EventWaitHandleRights.Modify);
            return handle.Set();
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            return false;
        }
    }

    public void Dispose()
    {
        _registration.Unregister(null);
        _handle.Dispose();
    }
}
