using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Otondev.Spike.Common;

/// <summary>
/// The measurement substrate for the whole spike.
///
/// Three processes under three different identities produce the evidence, so the log is
/// deliberately <b>one file per process</b> rather than one shared file: cross-process append
/// locking between LocalSystem and an interactive user needs an ACLed kernel mutex, and a
/// half-written line would silently corrupt a latency number. Separate files cannot interleave,
/// and <see cref="SpikeLogReader"/> merges them at read time.
///
/// Latencies are computed from <see cref="Environment.TickCount64"/>, not wall clock.
/// TickCount64 is milliseconds since boot from a single machine-wide source, so it is directly
/// comparable across processes; <see cref="DateTime.UtcNow"/> is kept only for human reading and
/// can be nudged by time sync mid-run.
/// </summary>
public static class SpikeLog
{
    private static readonly object Gate = new();
    private static string? _path;
    private static string _role = "unknown";
    private static bool _echo;

    public static JsonSerializerOptions JsonOptions { get; } = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    /// <summary>The correlation id shared by everything belonging to one spike run.</summary>
    public static string RunId { get; private set; } = "unset";

    public static string Role => _role;

    /// <param name="role">service | companion | probe</param>
    /// <param name="echo">also mirror to stdout — used by the console-mode and probe runs</param>
    public static void Open(string role, bool echo = false)
    {
        SpikePaths.EnsureDirectories();
        _role = role;
        _echo = echo;
        RunId = Environment.GetEnvironmentVariable("OTONDEV_SPIKE_RUN") ?? "adhoc";
        _path = Path.Combine(
            SpikePaths.Root,
            $"events.{role}-{Environment.ProcessId}.jsonl");
    }

    public static void Write(string kind, string message, object? data = null)
    {
        var line = JsonSerializer.Serialize(
            new SpikeEvent(
                DateTime.UtcNow.ToString("O"),
                Environment.TickCount64,
                RunId,
                _role,
                Environment.ProcessId,
                CurrentSessionId(),
                kind,
                message,
                data),
            JsonOptions);

        if (_echo)
        {
            Console.WriteLine($"[{_role}] {kind,-24} {message}");
        }

        if (_path is null)
        {
            return;
        }

        lock (Gate)
        {
            // Retry: the reader opens with FileShare.ReadWrite, but antivirus and indexers
            // can still hold a transient lock on a freshly created file.
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    using var stream = new FileStream(
                        _path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
                    var bytes = Encoding.UTF8.GetBytes(line + "\n");
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(flushToDisk: true);
                    return;
                }
                catch (IOException) when (attempt < 20)
                {
                    Thread.Sleep(25);
                }
            }
        }
    }

    /// <summary>Record an exception without letting logging failures mask the real error.</summary>
    public static void WriteError(string kind, string message, Exception ex) =>
        Write(kind, message, new { error = ex.GetType().Name, detail = ex.Message });

    private static int CurrentSessionId()
    {
        try
        {
            return Process.GetCurrentProcess().SessionId;
        }
        catch (InvalidOperationException)
        {
            return -1;
        }
    }
}

public sealed record SpikeEvent(
    [property: JsonPropertyName("ts")] string Ts,
    [property: JsonPropertyName("tick")] long Tick,
    [property: JsonPropertyName("run")] string Run,
    [property: JsonPropertyName("role")] string Role,
    [property: JsonPropertyName("pid")] int Pid,
    [property: JsonPropertyName("session")] int Session,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("msg")] string Message,
    [property: JsonPropertyName("data")] object? Data);
