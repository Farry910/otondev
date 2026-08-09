using System.ServiceProcess;
using Otondev.Spike.Common;

namespace Otondev.Spike.Service;

/// <summary>
/// The session-0 host.
///
/// <see cref="ServiceBase.CanHandleSessionChangeEvent"/> is the entire reason this is a
/// <see cref="ServiceBase"/> rather than a generic host worker: <c>OnSessionChange</c> is the
/// supported way for a session-0 process to learn about logon, logoff, lock, unlock and
/// RDP connect/disconnect, and those five events are exit criterion 2.
/// </summary>
public sealed class SpikeService : ServiceBase
{
    private readonly SupervisorCore _core;

    public SpikeService(SupervisorOptions options)
    {
        ServiceName = SpikePaths.ServiceName;
        CanHandleSessionChangeEvent = true;
        CanHandlePowerEvent = true;
        CanShutdown = true;
        CanStop = true;
        AutoLog = false;
        _core = new SupervisorCore(options);
    }

    protected override void OnStart(string[] args)
    {
        SpikeLog.Write("service.start", "OnStart", new { args });
        _core.Start();
    }

    protected override void OnStop()
    {
        SpikeLog.Write("service.stop", "OnStop");
        _core.StopAsync().GetAwaiter().GetResult();
    }

    /// <summary>
    /// Shutdown is logged separately from stop so that the reboot-survival evidence can
    /// distinguish "the service was stopped" from "the machine went down", and pair the
    /// shutdown record with the next boot's start record in the same log.
    /// </summary>
    protected override void OnShutdown()
    {
        SpikeLog.Write("service.shutdown", "machine is shutting down");
        _core.StopAsync().GetAwaiter().GetResult();
    }

    protected override void OnSessionChange(SessionChangeDescription change)
    {
        var desktopAvailable = change.Reason switch
        {
            SessionChangeReason.SessionLogon => true,
            SessionChangeReason.SessionUnlock => true,
            SessionChangeReason.ConsoleConnect => true,
            SessionChangeReason.RemoteConnect => true,
            _ => false,
        };

        _core.OnSessionChange(change.Reason.ToString(), change.SessionId, desktopAvailable);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _core.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
        base.Dispose(disposing);
    }
}
