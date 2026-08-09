using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Otondev.Spike.Common;

public enum Outcome
{
    /// <summary>The thing the criterion asks for was observed to happen.</summary>
    Pass,

    /// <summary>The thing was attempted and did not happen. A real, reportable failure.</summary>
    Fail,

    /// <summary>
    /// Could not be attempted here because a precondition of the *environment* was missing
    /// (no elevation, no second account, no reboot possible). Deliberately not <see cref="Fail"/>:
    /// conflating "we proved it does not work" with "we could not run the test" is the single
    /// easiest way for a spike to lie.
    /// </summary>
    Blocked,

    /// <summary>Context for the reader. Carries no verdict.</summary>
    Info,
}

public sealed record EvidenceRecord(
    string Ts,
    string Component,
    string Check,
    [property: JsonConverter(typeof(JsonStringEnumConverter))] Outcome Outcome,
    string Detail,
    double? Millis = null,
    string? Criterion = null);

/// <summary>
/// Append-only evidence log shared by every process in the spike.
///
/// The processes here run in different sessions, under different accounts, started by
/// different mechanisms; a shared JSONL file is the only channel all of them can reach.
/// Writes are open/append/close with a retry, because the service (LocalSystem) and the
/// companion (interactive user) genuinely do race on this file.
/// </summary>
public static class Evidence
{
    public static string Path { get; } =
        Environment.GetEnvironmentVariable("OTONDEV_SPIKE_EVIDENCE")
        ?? System.IO.Path.Combine(AppContext.BaseDirectory, "evidence.jsonl");

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly object Gate = new();

    public static void Record(
        string component,
        string check,
        Outcome outcome,
        string detail,
        double? millis = null,
        string? criterion = null)
    {
        var record = new EvidenceRecord(
            DateTimeOffset.UtcNow.ToString("O"),
            component,
            check,
            outcome,
            detail,
            millis is null ? null : Math.Round(millis.Value, 1),
            criterion);

        var line = JsonSerializer.Serialize(record, Json);

        lock (Gate)
        {
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    File.AppendAllText(Path, line + Environment.NewLine);
                    break;
                }
                catch (IOException) when (attempt < 20)
                {
                    Thread.Sleep(25);
                }
                catch (UnauthorizedAccessException) when (attempt < 20)
                {
                    Thread.Sleep(25);
                }
            }
        }

        var tag = outcome switch
        {
            Outcome.Pass => "PASS   ",
            Outcome.Fail => "FAIL   ",
            Outcome.Blocked => "BLOCKED",
            _ => "info   ",
        };
        var timing = millis is null ? string.Empty : $"  ({millis.Value:F1} ms)";
        Console.WriteLine($"{tag} [{component}] {check}: {detail}{timing}");
    }

    /// <summary>Time an action and record it, whatever it does.</summary>
    public static T Measure<T>(string component, string check, Func<T> action, string? criterion = null)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            var value = action();
            sw.Stop();
            Record(component, check, Outcome.Pass, "completed", sw.Elapsed.TotalMilliseconds, criterion);
            return value;
        }
        catch (Exception ex)
        {
            sw.Stop();
            Record(component, check, Outcome.Fail, $"{ex.GetType().Name}: {ex.Message}", sw.Elapsed.TotalMilliseconds, criterion);
            throw;
        }
    }
}
