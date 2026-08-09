using System.Text;
using System.Text.Json;

namespace Otondev.Spike.Common;

/// <summary>
/// Newline-delimited JSON over the named pipe. Byte-mode framing rather than message-mode:
/// message mode silently truncates a read whose buffer is too small, and a truncated frame
/// during the reconnect measurements would look like a protocol error rather than a sizing bug.
/// </summary>
public static class Wire
{
    public const string Hello = "hello";
    public const string HelloAck = "hello-ack";
    public const string Heartbeat = "heartbeat";
    public const string HeartbeatAck = "heartbeat-ack";
    public const string RunTask = "run-task";
    public const string TaskResult = "task-result";
    public const string Stop = "stop";
    public const string Rejected = "rejected";
}

/// <summary>Companion's opening frame. Everything here is evidence for an exit criterion.</summary>
public sealed record HelloPayload(
    string CompanionVersion,
    int Pid,
    int SessionId,
    string UserName,
    string UserSid,
    bool IsElevated,
    bool IsAdministrator,
    string IntegrityLevel,
    string WindowStation,
    string Desktop,
    long LaunchTick,
    long StartTick,
    string? LaunchId);

public sealed record HelloAckPayload(string ServiceSid, string LaunchId, long ServiceTick, bool Accepted, string? Reason);

public sealed record HeartbeatPayload(long Tick, string Health, int TargetPid);

public sealed record RunTaskPayload(string TaskId, string Kind, string TargetPath, string ExpectedText);

/// <summary>
/// The postcondition fields are the point of the whole task path: <see cref="Ok"/> means the
/// companion re-read the target application's state and it matched, not that an API returned S_OK.
/// </summary>
public sealed record TaskResultPayload(
    string TaskId,
    bool Ok,
    string Postcondition,
    string Observed,
    string Expected,
    long DurationMs,
    string? Error);

public sealed record StopPayload(string Reason);

/// <summary>A framed, typed duplex channel over an already-connected and already-authenticated pipe.</summary>
public sealed class PipeChannel(Stream stream) : IDisposable
{
    private readonly StreamReader _reader = new(stream, new UTF8Encoding(false), false, 8192, leaveOpen: true);
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly Stream _stream = stream;

    public async Task SendAsync<T>(string type, T payload, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(
            new { type, payload }, SpikeLog.JsonOptions);
        var bytes = Encoding.UTF8.GetBytes(json + "\n");

        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await _stream.WriteAsync(bytes, ct).ConfigureAwait(false);
            await _stream.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /// <summary>Returns null when the peer closed the pipe cleanly.</summary>
    public async Task<(string Type, JsonElement Payload)?> ReceiveAsync(CancellationToken ct)
    {
        var line = await _reader.ReadLineAsync(ct).ConfigureAwait(false);
        if (line is null)
        {
            return null;
        }

        using var doc = JsonDocument.Parse(line);
        var type = doc.RootElement.GetProperty("type").GetString() ?? "";
        var payload = doc.RootElement.TryGetProperty("payload", out var p)
            ? p.Clone()
            : default;
        return (type, payload);
    }

    public static T? As<T>(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Undefined
            ? default
            : payload.Deserialize<T>(SpikeLog.JsonOptions);

    public void Dispose()
    {
        _reader.Dispose();
        _writeLock.Dispose();
    }
}
