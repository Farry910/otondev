using System.Text;
using Otondev.Spike.Common;

namespace Otondev.Spike.Probe;

/// <summary>
/// Turns the merged event stream into the numbers and yes/no facts that FINDINGS.md cites.
///
/// Everything here is derived from logged events; nothing is asserted by the reporter itself.
/// If a criterion has no supporting events the report says "no evidence" rather than passing
/// it by omission — a spike that silently reports success for tests that never ran is worse
/// than one that fails.
/// </summary>
internal static class Report
{
    private static readonly string[] Measures =
    [
        "measure.companion_start_ms",
        "measure.reconnect_ms",
        "measure.task_ms",
        "measure.local_stop_ms",
        "measure.controlplane_detect_ms",
    ];

    internal static int Render(string? runId, string? outputPath)
    {
        var events = SpikeLogReader.ReadAll(runId);
        if (events.Count == 0)
        {
            Console.Error.WriteLine($"no events found in {SpikePaths.Root}" +
                                    (runId is null ? "" : $" for run '{runId}'"));
            return 1;
        }

        var report = new StringBuilder();
        void Line(string text = "") => report.AppendLine(text);

        Line($"# Windows session spike — measured evidence");
        Line();
        Line($"- events: **{events.Count}** from `{SpikePaths.Root}`");
        Line($"- runs: {string.Join(", ", events.Select(e => e.Run).Distinct().Select(r => $"`{r}`"))}");
        Line($"- window: `{events[0].Ts}` .. `{events[^1].Ts}`");
        Line();

        RenderMeasurements(events, Line);
        RenderLaunches(events, Line);
        RenderCompanionIdentity(events, Line);
        RenderIpc(events, Line);
        RenderSessionChanges(events, Line);
        RenderControlPlane(events, Line);
        RenderTasks(events, Line);

        var text = report.ToString();
        Console.WriteLine(text);

        if (outputPath is not null)
        {
            File.WriteAllText(outputPath, text, new UTF8Encoding(false));
            Console.Error.WriteLine($"written to {outputPath}");
        }

        return 0;
    }

    private static void RenderMeasurements(IReadOnlyList<LoggedEvent> events, Action<string> line)
    {
        line("## Measurements");
        line("");
        line("| metric | n | min ms | median ms | max ms |");
        line("|---|---:|---:|---:|---:|");

        foreach (var measure in Measures)
        {
            var samples = events
                .Where(e => e.Kind == measure)
                .Select(e => e.Num("ms"))
                .OfType<long>()
                .OrderBy(v => v)
                .ToList();

            if (samples.Count == 0)
            {
                line($"| `{measure.Replace("measure.", "")}` | 0 | — | — | — |");
                continue;
            }

            var median = samples[samples.Count / 2];
            line($"| `{measure.Replace("measure.", "")}` | {samples.Count} | {samples[0]} | {median} | {samples[^1]} |");
        }

        line("");
        line("Latencies are differences of `Environment.TickCount64` — one machine-wide monotonic");
        line("source, so values are comparable across the service and companion processes.");
        line("");
    }

    private static void RenderLaunches(IReadOnlyList<LoggedEvent> events, Action<string> line)
    {
        line("## Companion launches");
        line("");

        var attempts = events.Where(e => e.Kind is "companion.launch.ok" or "companion.launch.failed").ToList();
        if (attempts.Count == 0)
        {
            line("_no launch attempts recorded._");
            line("");
            return;
        }

        line("| when | result | mode/stage | pid | win32 | integrity | elevated | linked token |");
        line("|---|---|---|---:|---|---|---|---|");
        foreach (var attempt in attempts.TakeLast(15))
        {
            var ok = attempt.Kind.EndsWith("ok", StringComparison.Ordinal);
            line($"| {Time(attempt)} | {(ok ? "ok" : "**failed**")} " +
                 $"| {attempt.Str("mode") ?? attempt.Str("stage") ?? attempt.Message} " +
                 $"| {attempt.Num("pid")?.ToString() ?? "—"} " +
                 $"| {attempt.Str("win32_meaning") ?? "—"} " +
                 $"| {attempt.Str("token_integrity") ?? "—"} " +
                 $"| {attempt.Flag("token_is_elevated")?.ToString() ?? "—"} " +
                 $"| {attempt.Flag("used_linked_token")?.ToString() ?? "—"} |");
        }
        line("");
    }

    private static void RenderCompanionIdentity(IReadOnlyList<LoggedEvent> events, Action<string> line)
    {
        line("## Companion privilege (criterion 4)");
        line("");

        var hellos = events.Where(e => e.Kind == "companion.hello").ToList();
        if (hellos.Count == 0)
        {
            line("_no companion ever completed a handshake — **no evidence** for this criterion._");
            line("");
            return;
        }

        line("| when | session | user | elevated | administrator | integrity | window station | desktop |");
        line("|---|---:|---|---|---|---|---|---|");
        foreach (var hello in hellos.TakeLast(10))
        {
            line($"| {Time(hello)} | {hello.Num("SessionId")} | {hello.Str("UserName")} " +
                 $"| {hello.Flag("IsElevated")} | {hello.Flag("IsAdministrator")} " +
                 $"| {hello.Str("IntegrityLevel")} | {hello.Str("WindowStation")} | {hello.Str("Desktop")} |");
        }

        var anyElevated = hellos.Any(h => h.Flag("IsElevated") == true);
        line("");
        line(anyElevated
            ? "> **At least one companion ran elevated.** The least-privilege claim does not hold as built."
            : "> Every companion that handshook reported a non-elevated token.");
        line("");
    }

    private static void RenderIpc(IReadOnlyList<LoggedEvent> events, Action<string> line)
    {
        line("## IPC authentication (criterion 5)");
        line("");

        var accepted = events.Where(e => e.Kind == "ipc.accepted").ToList();
        var rejected = events.Where(e => e.Kind == "ipc.rejected").ToList();
        var serverAuth = events.Where(e => e.Kind is "ipc.server_authenticated" or "ipc.server_rejected").ToList();
        var intruderAccepted = events.Where(e => e.Kind == "intruder.accepted").ToList();
        var leaked = events.Where(e => e.Kind == "squatter.leaked").ToList();

        line($"- server accepted the companion: **{accepted.Count}**");
        line($"- server rejected a caller: **{rejected.Count}**");
        line($"- companion authenticated the server: **{serverAuth.Count(e => e.Kind == "ipc.server_authenticated")}** " +
             $"(refused **{serverAuth.Count(e => e.Kind == "ipc.server_rejected")}**)");
        line($"- unauthorized caller was **admitted**: {intruderAccepted.Count} " +
             $"{(intruderAccepted.Count == 0 ? "(good)" : "(**DEFECT**)")}");
        line($"- companion disclosed data to a rogue server: {leaked.Count} " +
             $"{(leaked.Count == 0 ? "(good)" : "(**DEFECT**)")}");
        line("");

        if (rejected.Count > 0)
        {
            line("Rejections:");
            line("");
            foreach (var reject in rejected.TakeLast(10))
            {
                line($"- `{Time(reject)}` pid {reject.Num("peer_pid")} " +
                     $"(`{reject.Str("peer_user")}`, `{Path.GetFileName(reject.Str("peer_image") ?? "?")}`) — {reject.Message}");
            }
            line("");
        }

        var acl = events.LastOrDefault(e => e.Kind == "ipc.acl.observed");
        if (acl?.Data is { } data)
        {
            line("Observed pipe DACL:");
            line("");
            line("```json");
            line(data.ToString());
            line("```");
            line("");
        }
    }

    private static void RenderSessionChanges(IReadOnlyList<LoggedEvent> events, Action<string> line)
    {
        line("## Session lifecycle (criterion 2)");
        line("");

        var changes = events.Where(e => e.Kind == "session.change").ToList();
        var starts = events.Where(e => e.Kind is "service.start" or "host.service").ToList();
        var shutdowns = events.Where(e => e.Kind == "service.shutdown").ToList();

        if (changes.Count == 0)
        {
            line("_no `OnSessionChange` notifications recorded._");
        }
        else
        {
            line("| when | reason | session | desktop available |");
            line("|---|---|---:|---|");
            foreach (var change in changes.TakeLast(20))
            {
                line($"| {Time(change)} | `{change.Message}` | {change.Num("session")} | {change.Flag("desktop_available")} |");
            }
        }

        line("");
        line($"- service starts recorded: **{starts.Count}**");
        line($"- machine shutdowns recorded: **{shutdowns.Count}**");
        line(shutdowns.Count > 0 && starts.Count > shutdowns.Count
            ? "- a start follows a shutdown in this log, which is the reboot-survival evidence."
            : "- **no shutdown/start pair** — reboot survival is not evidenced by this log.");
        line("");
    }

    private static void RenderControlPlane(IReadOnlyList<LoggedEvent> events, Action<string> line)
    {
        line("## Control plane unreachable (criterion 6)");
        line("");

        var detect = events.Where(e => e.Kind == "measure.controlplane_detect_ms").ToList();
        var breaker = events.Where(e => e.Kind == "controlplane.breaker_open").ToList();
        var unreachable = events.Where(e => e.Kind == "controlplane.unreachable").ToList();
        var reachable = events.Where(e => e.Kind == "controlplane.reachable").ToList();

        line($"- unreachable detections: **{detect.Count}**, breaker openings: **{breaker.Count}**, " +
             $"repeat notices: **{unreachable.Count}**, successful connects: **{reachable.Count}**");

        var aliveDuring = breaker.Concat(unreachable).Select(e => e.Flag("companion_alive")).OfType<bool>().ToList();
        if (aliveDuring.Count > 0)
        {
            line($"- companion alive while the control plane was down: " +
                 $"**{aliveDuring.Count(a => a)}/{aliveDuring.Count}** samples");
        }
        else
        {
            line("- _no samples of companion liveness during an outage._");
        }

        var stops = events.Where(e => e.Kind == "companion.local_stop").ToList();
        line($"- local stop landed while the control plane was unreachable: **{stops.Count}** time(s)");
        line("");
    }

    private static void RenderTasks(IReadOnlyList<LoggedEvent> events, Action<string> line)
    {
        line("## Target application postconditions (criterion 3)");
        line("");

        var results = events.Where(e => e.Kind is "task.ok" or "task.failed").ToList();
        if (results.Count == 0)
        {
            line("_no task results recorded — **no evidence** for this criterion._");
            line("");
            return;
        }

        line("| when | task | ok | postcondition | observed | error |");
        line("|---|---|---|---|---|---|");
        foreach (var result in results.TakeLast(15))
        {
            line($"| {Time(result)} | {result.Str("TaskId")} | {(result.Kind == "task.ok" ? "yes" : "**no**")} " +
                 $"| {result.Str("Postcondition")} | {result.Str("Observed")} | {result.Str("Error") ?? "—"} |");
        }

        var ok = results.Count(r => r.Kind == "task.ok");
        line("");
        line($"**{ok}/{results.Count}** task attempts verified the postcondition from both the saved file " +
             "and the live UI Automation tree.");
        line("");
    }

    private static string Time(LoggedEvent e) =>
        DateTime.TryParse(e.Ts, null, System.Globalization.DateTimeStyles.RoundtripKind, out var parsed)
            ? parsed.ToString("HH:mm:ss.fff")
            : e.Ts;
}
