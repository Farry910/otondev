using System.Text.Json;

namespace Otondev.Spike.Common;

/// <summary>One parsed line from the merged event stream.</summary>
public sealed record LoggedEvent(
    string Ts, long Tick, string Run, string Role, int Pid, int Session,
    string Kind, string Message, JsonElement? Data)
{
    public string? Str(string key) =>
        Data is { } d && d.ValueKind == JsonValueKind.Object && d.TryGetProperty(key, out var v)
            ? v.ValueKind == JsonValueKind.String ? v.GetString() : v.ToString()
            : null;

    public long? Num(string key) =>
        Data is { } d && d.ValueKind == JsonValueKind.Object && d.TryGetProperty(key, out var v)
            && v.ValueKind is JsonValueKind.Number && v.TryGetInt64(out var n)
            ? n : null;

    public bool? Flag(string key) =>
        Data is { } d && d.ValueKind == JsonValueKind.Object && d.TryGetProperty(key, out var v)
            && v.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? v.GetBoolean() : null;
}

public static class SpikeLogReader
{
    /// <summary>
    /// Merge every per-process log into one timeline ordered by boot-relative tick.
    ///
    /// Malformed trailing lines are skipped rather than fatal: a process killed mid-write
    /// (which the reboot and emergency-stop tests do on purpose) can leave a partial last
    /// line, and losing that one line must not cost us the rest of the evidence.
    /// </summary>
    public static IReadOnlyList<LoggedEvent> ReadAll(string? runId = null)
    {
        if (!Directory.Exists(SpikePaths.Root))
        {
            return [];
        }

        var events = new List<LoggedEvent>();
        foreach (var file in Directory.EnumerateFiles(SpikePaths.Root, "events.*.jsonl"))
        {
            foreach (var line in ReadLinesTolerantly(file))
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                LoggedEvent? parsed;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    var root = doc.RootElement;
                    parsed = new LoggedEvent(
                        root.GetProperty("ts").GetString() ?? "",
                        root.GetProperty("tick").GetInt64(),
                        Prop(root, "run") ?? "",
                        Prop(root, "role") ?? "",
                        root.TryGetProperty("pid", out var pid) ? pid.GetInt32() : -1,
                        root.TryGetProperty("session", out var s) ? s.GetInt32() : -1,
                        Prop(root, "kind") ?? "",
                        Prop(root, "msg") ?? "",
                        root.TryGetProperty("data", out var data) ? data.Clone() : null);
                }
                catch (JsonException)
                {
                    continue;
                }
                catch (KeyNotFoundException)
                {
                    continue;
                }
                catch (InvalidOperationException)
                {
                    continue;
                }

                events.Add(parsed);
            }
        }

        return events
            .Where(e => runId is null || e.Run == runId)
            .OrderBy(e => e.Tick)
            .ThenBy(e => e.Ts, StringComparer.Ordinal)
            .ToList();
    }

    private static string? Prop(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) ? v.GetString() : null;

    private static IEnumerable<string> ReadLinesTolerantly(string file)
    {
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        while (reader.ReadLine() is { } line)
        {
            yield return line;
        }
    }

    /// <summary>Distinct run ids present, oldest first.</summary>
    public static IReadOnlyList<string> Runs() =>
        ReadAll().Select(e => e.Run).Distinct().ToList();
}
