using System.ServiceProcess;
using Otondev.Spike.Common;
using Otondev.Spike.Service;

// Two hosts over one supervisor:
//
//   --service   real session-0 Windows service (installed by scripts\install-service.ps1)
//   --console   same supervisor in the caller's own session
//
// Console mode exists so the IPC, authorisation, target-application and control-plane
// measurements can be taken on a machine where nobody can install a service. It is a
// *degraded* mode by construction and every event it writes is tagged SameSession so the
// findings cannot accidentally cite it as cross-session evidence.

var argv = new ArgList(args);
var mode = argv.Value("--mode") ?? (argv.Has("--console") ? "console" : "service");

var launchMode = argv.Value("--launch-mode") switch
{
    "same" => LaunchMode.SameSession,
    "cross" => LaunchMode.CrossSession,
    _ => mode == "console" ? LaunchMode.SameSession : LaunchMode.CrossSession,
};

var controlPlane = (argv.Value("--control-plane") ?? "127.0.0.1:59999").Split(':');
var options = new SupervisorOptions(
    launchMode,
    argv.Value("--companion") ?? SpikePaths.CompanionExe,
    controlPlane[0],
    controlPlane.Length > 1 && int.TryParse(controlPlane[1], out var port) ? port : 59999,
    TimeSpan.FromSeconds(double.TryParse(argv.Value("--interval"), out var i) ? i : 15),
    argv.Has("--show"));

if (mode == "console")
{
    SpikeLog.Open("service", echo: true);
    SpikeLog.Write("host.console", "running supervisor in console mode", new
    {
        launch_mode = launchMode.ToString(),
        identity = TokenInfo.Describe(),
    });

    var duration = TimeSpan.FromSeconds(double.TryParse(argv.Value("--duration"), out var d) ? d : 45);
    await using var core = new SupervisorCore(options);
    core.Start();

    using var stopping = new CancellationTokenSource(duration);
    Console.CancelKeyPress += (_, e) =>
    {
        e.Cancel = true;
        stopping.Cancel();
    };

    try
    {
        await Task.Delay(Timeout.InfiniteTimeSpan, stopping.Token);
    }
    catch (OperationCanceledException)
    {
        // Duration elapsed or Ctrl+C — both are a normal end to a console run.
    }

    await core.StopAsync();
    SpikeLog.Write("host.console.done", "console run complete");
    return 0;
}

SpikeLog.Open("service");
SpikeLog.Write("host.service", "entering ServiceBase.Run", new { identity = TokenInfo.Describe() });
using var service = new SpikeService(options);
ServiceBase.Run(service);
return 0;

/// <summary>Minimal argument reader. A spike does not need a command-line framework.</summary>
internal sealed class ArgList(string[] args)
{
    public bool Has(string name) => Array.IndexOf(args, name) >= 0;

    public string? Value(string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }
}
