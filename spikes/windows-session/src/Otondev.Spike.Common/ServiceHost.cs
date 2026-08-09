using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Otondev.Spike.Common;

/// <summary>
/// A minimal Windows service control dispatcher, by P/Invoke.
///
/// Two reasons not to take a dependency here. First, the spike must build and run with no
/// package restore, because a spike that cannot be rebuilt in six months is not evidence.
/// Second, and more usefully: <see cref="SessionChange"/> is the exact mechanism S17 needs for
/// "survives reboot, logoff, lock, and reconnect", and routing it through a framework wrapper
/// would hide the thing the spike is supposed to be testing.
/// </summary>
public static class ServiceHost
{
    public enum State
    {
        Stopped = 1,
        StartPending = 2,
        StopPending = 3,
        Running = 4,
    }

    public enum SessionEvent
    {
        ConsoleConnect = 0x1,
        ConsoleDisconnect = 0x2,
        RemoteConnect = 0x3,
        RemoteDisconnect = 0x4,
        SessionLogon = 0x5,
        SessionLogoff = 0x6,
        SessionLock = 0x7,
        SessionUnlock = 0x8,
        SessionRemoteControl = 0x9,
    }

    private const int ServiceWin32OwnProcess = 0x00000010;

    private const int ControlStop = 0x00000001;
    private const int ControlShutdown = 0x00000005;
    private const int ControlSessionChange = 0x0000000E;
    private const int ControlPreShutdown = 0x0000000F;

    private const int AcceptStop = 0x00000001;
    private const int AcceptShutdown = 0x00000004;
    private const int AcceptSessionChange = 0x00000080;
    private const int AcceptPreShutdown = 0x00000100;

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus
    {
        public int ServiceType;
        public int CurrentState;
        public int ControlsAccepted;
        public int Win32ExitCode;
        public int ServiceSpecificExitCode;
        public int CheckPoint;
        public int WaitHint;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WtsSessionNotification
    {
        public int Size;
        public int SessionId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ServiceTableEntry
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string? Name;
        public IntPtr Proc;
    }

    private delegate void ServiceMainDelegate(int argc, IntPtr argv);
    private delegate int HandlerExDelegate(int control, int eventType, IntPtr eventData, IntPtr context);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool StartServiceCtrlDispatcherW(ServiceTableEntry[] table);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr RegisterServiceCtrlHandlerExW(string serviceName, HandlerExDelegate handler, IntPtr context);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetServiceStatus(IntPtr handle, ref ServiceStatus status);

    // Kept alive for the process lifetime: the SCM holds native pointers to both, and letting
    // the GC collect the delegates is a crash that only shows up under load.
    private static ServiceMainDelegate? _mainDelegate;
    private static HandlerExDelegate? _handlerDelegate;

    private static IntPtr _statusHandle;
    private static ServiceStatus _status;
    private static string _serviceName = "otondev-spike-supervisor";

    private static Action<CancellationToken>? _run;
    private static Action<SessionEvent, int>? _onSessionChange;
    private static Action<int>? _onUserControl;
    private static readonly CancellationTokenSource Stopping = new();

    /// <summary>
    /// User-defined service controls. These are how an operator reaches the service with no
    /// network in the path at all: <c>sc control &lt;name&gt; 128</c> goes local RPC to the SCM,
    /// and access is governed by the service's own security descriptor. A listening socket or a
    /// control-plane callback would both fail in exactly the situation containment is for.
    /// </summary>
    public const int ControlContain = 128;

    public const int ControlRelease = 129;

    /// <summary>
    /// Hand control to the SCM. Blocks until the service stops.
    /// Returns false if the process was not started by the SCM (error 1063), which is how the
    /// same executable can also run as a console app for unelevated testing.
    /// </summary>
    public static bool Run(
        string serviceName,
        Action<CancellationToken> run,
        Action<SessionEvent, int>? onSessionChange = null,
        Action<int>? onUserControl = null)
    {
        _serviceName = serviceName;
        _run = run;
        _onSessionChange = onSessionChange;
        _onUserControl = onUserControl;
        _mainDelegate = ServiceMain;

        var table = new[]
        {
            new ServiceTableEntry { Name = serviceName, Proc = Marshal.GetFunctionPointerForDelegate(_mainDelegate) },
            new ServiceTableEntry { Name = null, Proc = IntPtr.Zero },
        };

        if (StartServiceCtrlDispatcherW(table))
        {
            return true;
        }

        const int errorFailedServiceControllerConnect = 1063;
        var error = Marshal.GetLastWin32Error();
        if (error == errorFailedServiceControllerConnect)
        {
            return false;
        }

        throw new Win32Exception(error, "StartServiceCtrlDispatcher");
    }

    private static void ServiceMain(int argc, IntPtr argv)
    {
        _handlerDelegate = HandlerEx;
        _statusHandle = RegisterServiceCtrlHandlerExW(_serviceName, _handlerDelegate, IntPtr.Zero);
        if (_statusHandle == IntPtr.Zero)
        {
            return;
        }

        _status = new ServiceStatus
        {
            ServiceType = ServiceWin32OwnProcess,
            CurrentState = (int)State.StartPending,
            ControlsAccepted = 0,
            WaitHint = 10_000,
        };
        SetServiceStatus(_statusHandle, ref _status);

        try
        {
            Report(State.Running);
            _run!(Stopping.Token);
        }
        catch (Exception ex)
        {
            Evidence.Record("supervisor", "service-main", Outcome.Fail, $"{ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            Report(State.Stopped);
        }
    }

    public static void Report(State state)
    {
        if (_statusHandle == IntPtr.Zero) return;

        _status.CurrentState = (int)state;
        _status.ControlsAccepted = state == State.Running
            ? AcceptStop | AcceptShutdown | AcceptSessionChange | AcceptPreShutdown
            : 0;
        _status.WaitHint = state is State.StartPending or State.StopPending ? 10_000 : 0;
        SetServiceStatus(_statusHandle, ref _status);
    }

    private static int HandlerEx(int control, int eventType, IntPtr eventData, IntPtr context)
    {
        const int noError = 0;

        switch (control)
        {
            case ControlStop:
            case ControlShutdown:
            case ControlPreShutdown:
                Evidence.Record("supervisor", "service-control", Outcome.Info, $"control {control}: stopping");
                Report(State.StopPending);
                Stopping.Cancel();
                return noError;

            case ControlSessionChange:
                var notification = Marshal.PtrToStructure<WtsSessionNotification>(eventData);
                _onSessionChange?.Invoke((SessionEvent)eventType, notification.SessionId);
                return noError;

            case >= ControlContain and <= 255:
                _onUserControl?.Invoke(control);
                return noError;

            default:
                return noError;
        }
    }

    public static bool IsStopping => Stopping.IsCancellationRequested;
}
