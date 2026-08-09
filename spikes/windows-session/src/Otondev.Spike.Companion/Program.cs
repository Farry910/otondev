using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using Otondev.Spike.Common;
using Otondev.Spike.Companion;

// The interactive half of the pair. Launched by the supervisor — never started by a user in
// normal operation — and deliberately unprivileged.

SpikeLog.Open("companion", echo: Environment.GetEnvironmentVariable("OTONDEV_SPIKE_ECHO") == "1");

var argv = new CompanionArgs(args);
var launchId = argv.Value("--launch") ?? "unknown";
var launchTick = argv.Long("--launch-tick") ?? Environment.TickCount64;
var expectedOwner = argv.Value("--expect-server-owner");
var startTick = Environment.TickCount64;

var identity = TokenInfo.Describe();
var lastTargetPid = 0;
SpikeLog.Write("companion.identity", "what the companion is actually running as", new
{
    launch_id = launchId,
    reason = argv.Value("--reason"),
    identity,
    // Criterion 4 in one field: on a correct launch this is false even when the logged-on
    // user is a local administrator.
    non_administrator = !identity.IsElevated,
});

// Standalone drive of the target application, with no supervisor and no IPC. Exists so the
// UI-automation half can be developed and diagnosed on its own; a failure here is a target-app
// finding, a failure only under the supervisor is a session or privilege finding.
if (argv.Value("--selftest") is not null || args.Contains("--selftest"))
{
    SpikePaths.EnsureDirectories();
    var probeTask = new RunTaskPayload(
        "selftest",
        "notepad-roundtrip",
        Path.Combine(SpikePaths.WorkDir, "target-selftest.txt"),
        $"otondev-selftest {Environment.TickCount64}");

    var selfOutcome = TargetAppDriver.Run(probeTask, CancellationToken.None);
    Console.WriteLine($"ok         : {selfOutcome.Ok}");
    Console.WriteLine($"postcond   : {selfOutcome.Postcondition}");
    Console.WriteLine($"observed   : {selfOutcome.Observed}");
    Console.WriteLine($"duration   : {selfOutcome.DurationMs} ms");
    Console.WriteLine($"error      : {selfOutcome.Error ?? "none"}");
    return selfOutcome.Ok ? 0 : 1;
}

using var lifetime = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    lifetime.Cancel();
};

var stopWatcher = Task.Run(() => WatchLocalStopAsync(lifetime));

int exitCode;
try
{
    exitCode = await RunAsync(lifetime.Token);
}
catch (OperationCanceledException)
{
    exitCode = 0;
}

await lifetime.CancelAsync();
await stopWatcher;
SpikeLog.Write("companion.exit", $"exit code {exitCode}", new { launch_id = launchId });
return exitCode;

async Task<int> RunAsync(CancellationToken ct)
{
    var client = await ConnectAsync(ct);
    if (client is null)
    {
        return 2;
    }

    using (client)
    {
        // Authenticate the *server* before saying anything to it. Pipe names are an
        // unreserved global namespace, so "I connected" is not "I connected to my supervisor".
        if (!VerifyServer(client, expectedOwner))
        {
            return 3;
        }

        using var channel = new PipeChannel(client);
        await channel.SendAsync(
            Wire.Hello,
            new HelloPayload(
                CompanionVersion: "spike-1",
                Pid: Environment.ProcessId,
                SessionId: identity.SessionId,
                UserName: identity.UserName,
                UserSid: identity.UserSid,
                IsElevated: identity.IsElevated,
                IsAdministrator: identity.IsAdministrator,
                IntegrityLevel: identity.IntegrityLevel,
                WindowStation: identity.WindowStation,
                Desktop: identity.Desktop,
                LaunchTick: launchTick,
                StartTick: startTick,
                LaunchId: launchId),
            ct);

        var heartbeat = Task.Run(() => HeartbeatAsync(channel, ct), CancellationToken.None);
        var currentTask = Task.CompletedTask;

        try
        {
            while (!ct.IsCancellationRequested)
            {
                var frame = await channel.ReceiveAsync(ct);
                if (frame is null)
                {
                    SpikeLog.Write("ipc.closed", "supervisor closed the channel");
                    break;
                }

                switch (frame.Value.Type)
                {
                    case Wire.HelloAck:
                        var ack = PipeChannel.As<HelloAckPayload>(frame.Value.Payload);
                        SpikeLog.Write("ipc.hello_ack", "supervisor accepted the companion", new
                        {
                            service_sid = ack?.ServiceSid,
                            accepted = ack?.Accepted,
                        });
                        break;

                    case Wire.Rejected:
                        SpikeLog.Write("ipc.rejected_by_server", "supervisor refused this companion");
                        return 4;

                    case Wire.RunTask:
                        var task = PipeChannel.As<RunTaskPayload>(frame.Value.Payload);
                        if (task is not null)
                        {
                            // Run off the read loop so heartbeats and stop frames keep flowing
                            // while a multi-second UI drive is in progress.
                            currentTask = RunTaskAsync(channel, task, ct);
                        }
                        break;

                    case Wire.Stop:
                        var stop = PipeChannel.As<StopPayload>(frame.Value.Payload);
                        SpikeLog.Write("companion.stop", stop?.Reason ?? "supervisor asked us to stop");
                        return 0;

                    case Wire.HeartbeatAck:
                        break;

                    default:
                        SpikeLog.Write("ipc.unknown_frame", frame.Value.Type);
                        break;
                }
            }
        }
        catch (IOException ex)
        {
            SpikeLog.WriteError("ipc.broken", "channel to supervisor", ex);
            return 5;
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
        finally
        {
            await SwallowAsync(currentTask);
            await SwallowAsync(heartbeat);
        }
    }

    return 0;
}

async Task<NamedPipeClientStream?> ConnectAsync(CancellationToken ct)
{
    var deadline = Environment.TickCount64 + 30_000;
    var attempt = 0;

    while (Environment.TickCount64 < deadline && !ct.IsCancellationRequested)
    {
        attempt++;
        // Identification, not Impersonation: the supervisor identifies this process from the
        // kernel's pipe metadata and never needs to act as it, so handing over an
        // impersonation-capable token would be privilege the design does not require.
        var client = new NamedPipeClientStream(
            ".", SpikePaths.PipeName, PipeDirection.InOut,
            PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);

        try
        {
            await client.ConnectAsync(1000, ct);
            SpikeLog.Write("ipc.connected", $"connected on attempt {attempt}", new
            {
                attempt,
                ms_since_start = Environment.TickCount64 - startTick,
            });
            return client;
        }
        catch (TimeoutException)
        {
            await client.DisposeAsync();
        }
        catch (OperationCanceledException)
        {
            await client.DisposeAsync();
            return null;
        }
        catch (IOException ex)
        {
            SpikeLog.WriteError("ipc.connect.retry", $"attempt {attempt}", ex);
            await client.DisposeAsync();
            await Task.Delay(250, CancellationToken.None);
        }
    }

    SpikeLog.Write("ipc.connect.failed", "no supervisor pipe within 30s", new { attempts = attempt });
    return null;
}

bool VerifyServer(NamedPipeClientStream client, string? expected)
{
    SecurityIdentifier owner;
    try
    {
        owner = PipeAuth.GetPipeOwner(client.SafePipeHandle);
    }
    catch (System.ComponentModel.Win32Exception ex)
    {
        SpikeLog.WriteError("ipc.server_auth.failed", "could not read pipe owner", ex);
        return false;
    }

    var isSystem = owner.IsWellKnown(WellKnownSidType.LocalSystemSid);
    var matches = expected is null || string.Equals(owner.Value, expected, StringComparison.OrdinalIgnoreCase);

    SpikeLog.Write(matches ? "ipc.server_authenticated" : "ipc.server_rejected",
        matches ? "pipe owner matches the expected supervisor identity" : "pipe owner is not the supervisor",
        new
        {
            owner = owner.Value,
            owner_is_local_system = isSystem,
            expected,
            matches,
        });

    return matches;
}

async Task RunTaskAsync(PipeChannel channel, RunTaskPayload task, CancellationToken ct)
{
    var outcome = await Task.Run(() => TargetAppDriver.Run(task, ct), CancellationToken.None);
    lastTargetPid = outcome.TargetPid;

    await channel.SendAsync(
        Wire.TaskResult,
        new TaskResultPayload(
            task.TaskId, outcome.Ok, outcome.Postcondition, outcome.Observed,
            outcome.Expected, outcome.DurationMs, outcome.Error),
        ct);
}

async Task HeartbeatAsync(PipeChannel channel, CancellationToken ct)
{
    try
    {
        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
            await channel.SendAsync(
                Wire.Heartbeat,
                new HeartbeatPayload(Environment.TickCount64, "ok", lastTargetPid),
                ct);
        }
    }
    catch (Exception ex) when (ex is OperationCanceledException or IOException or ObjectDisposedException)
    {
        // The read loop owns reporting channel failures.
    }
}

/// <summary>
/// Emergency stop that does not traverse the control plane, the network, or even the IPC
/// channel. The companion watches the sentinel itself so a stop still lands if the supervisor
/// is wedged — which is the case the operator most needs it to work in.
/// </summary>
async Task WatchLocalStopAsync(CancellationTokenSource cts)
{
    var sentinel = Path.Combine(SpikePaths.Root, "STOP");
    while (!cts.IsCancellationRequested)
    {
        if (File.Exists(sentinel))
        {
            var requestedTick = ReadTick(sentinel);
            SpikeLog.Write("companion.local_stop", "STOP sentinel observed; stopping now");
            if (requestedTick is { } tick)
            {
                SpikeLog.Write("measure.local_stop_ms", "STOP sentinel to companion reaction", new
                {
                    ms = Environment.TickCount64 - tick,
                });
            }

            await cts.CancelAsync();
            return;
        }

        try
        {
            await Task.Delay(100, cts.Token);
        }
        catch (OperationCanceledException)
        {
            return;
        }
    }
}

static long? ReadTick(string path)
{
    try
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        return long.TryParse(reader.ReadToEnd().Trim(), out var tick) ? tick : null;
    }
    catch (IOException)
    {
        return null;
    }
}

static async Task SwallowAsync(Task task)
{
    try
    {
        await task;
    }
    catch (Exception ex) when (ex is OperationCanceledException or IOException or ObjectDisposedException)
    {
        // Shutdown races; the interesting failures are already logged at their source.
    }
}

internal sealed class CompanionArgs(string[] args)
{
    public string? Value(string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    public long? Long(string name) =>
        long.TryParse(Value(name), out var value) ? value : null;
}
