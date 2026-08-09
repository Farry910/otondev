using Otondev.Spike.Common;
using Otondev.Spike.Probe;

// Harness for the spike. Every mode is safe to run unelevated; several of them are *designed*
// to be run unelevated, because "what does an ordinary local process get away with" is the
// question criterion 5 asks.

var mode = args.Length > 0 ? args[0] : "help";
var rest = new ProbeArgs(args);

SpikeLog.Open("probe", echo: false);
SpikePaths.EnsureDirectories();

using var cancellation = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    cancellation.Cancel();
};

switch (mode)
{
    case "preflight":
        return Preflight.Run();

    case "intruder":
        return await SecurityTests.Intrude(cancellation.Token);

    case "squatter":
        return await SecurityTests.Squat(
            TimeSpan.FromSeconds(rest.Double("--seconds") ?? 30), cancellation.Token);

    case "stop":
        return Stop();

    case "resume":
        return Resume();

    case "report":
        return Report.Render(rest.Value("--run"), rest.Value("--out"));

    case "clean":
        return Clean();

    default:
        Console.WriteLine("""
            Otondev Windows session spike — probe

              preflight              what this identity can and cannot do
              intruder               unauthorized local caller vs the supervisor pipe
              squatter [--seconds N] rogue pipe server vs the companion
              stop                   drop the STOP sentinel (emergency containment)
              resume                 clear the STOP sentinel
              report [--run ID] [--out FILE]
                                     render measured evidence as markdown
              clean                  delete event logs and sentinels for a fresh run
            """);
        return 0;
}

/// <summary>
/// The sentinel carries the tick at which it was written so the companion can measure its own
/// reaction latency against a clock both processes share. Writing the file is the whole
/// mechanism: no network, no control plane, no IPC.
/// </summary>
int Stop()
{
    var sentinel = Path.Combine(SpikePaths.Root, "STOP");
    var tick = Environment.TickCount64;
    File.WriteAllText(sentinel, tick.ToString());
    SpikeLog.Write("emergency.stop.requested", "STOP sentinel written", new { tick, path = sentinel });
    Console.WriteLine($"STOP written to {sentinel} (tick {tick})");
    return 0;
}

int Resume()
{
    var sentinel = Path.Combine(SpikePaths.Root, "STOP");
    if (File.Exists(sentinel))
    {
        File.Delete(sentinel);
        SpikeLog.Write("emergency.stop.cleared", "STOP sentinel removed");
        Console.WriteLine("STOP cleared");
    }
    else
    {
        Console.WriteLine("no STOP sentinel present");
    }
    return 0;
}

int Clean()
{
    var removed = 0;
    foreach (var file in Directory.EnumerateFiles(SpikePaths.Root, "events.*.jsonl"))
    {
        try
        {
            File.Delete(file);
            removed++;
        }
        catch (IOException)
        {
            Console.Error.WriteLine($"in use, kept: {file}");
        }
    }

    var sentinel = Path.Combine(SpikePaths.Root, "STOP");
    if (File.Exists(sentinel))
    {
        File.Delete(sentinel);
    }

    if (Directory.Exists(SpikePaths.WorkDir))
    {
        foreach (var file in Directory.EnumerateFiles(SpikePaths.WorkDir, "target-*.txt"))
        {
            try
            {
                File.Delete(file);
            }
            catch (IOException)
            {
                // Still open in the editor; harmless.
            }
        }
    }

    Console.WriteLine($"removed {removed} event log(s) from {SpikePaths.Root}");
    return 0;
}

internal sealed class ProbeArgs(string[] args)
{
    public string? Value(string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    public double? Double(string name) =>
        double.TryParse(Value(name), out var value) ? value : null;
}
