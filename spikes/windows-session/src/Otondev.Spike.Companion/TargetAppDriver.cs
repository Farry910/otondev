using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Automation;
using Otondev.Spike.Common;

namespace Otondev.Spike.Companion;

/// <summary>
/// Drives a real Windows application and then checks that the application's state actually
/// changed (exit criterion 3).
///
/// The distinction the criterion is drawing — "a postcondition, not just 'the call returned'" —
/// is the whole design of this type. Every step here can report success while achieving
/// nothing: <c>Process.Start</c> succeeds if the app never draws, <c>SendInput</c> returns the
/// event count even when the events land on a window nobody can see, and Ctrl+S "works" whether
/// or not a byte reaches the disk. So the result is decided by two independent readings taken
/// afterwards, from two different places:
///
///   A. the file on disk contains the text (the app did work and persisted it);
///   B. the UI Automation tree reports the text in the editor (the app's live state matches).
///
/// A passes only if the application really performed the save; B passes only if the companion
/// really has a view into the interactive session. Reporting them separately means a partial
/// result stays diagnosable instead of collapsing to "failed".
/// </summary>
internal static class TargetAppDriver
{
    private const string TargetExe = "notepad.exe";

    internal sealed record DriveOutcome(
        bool Ok,
        string Postcondition,
        string Observed,
        string Expected,
        long DurationMs,
        string? Error,
        int TargetPid);

    internal static DriveOutcome Run(RunTaskPayload task, CancellationToken ct)
    {
        var started = Environment.TickCount64;
        var targetPid = 0;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(task.TargetPath)!);
            var seed = $"otondev spike target file{Environment.NewLine}";
            File.WriteAllText(task.TargetPath, seed, new UTF8Encoding(false));

            SpikeLog.Write("target.launch", TargetExe, new { task.TaskId, task.TargetPath });
            var launched = Process.Start(new ProcessStartInfo(TargetExe, $"\"{task.TargetPath}\"")
            {
                UseShellExecute = true,
            });

            var window = WaitForWindow(task.TargetPath, launched, TimeSpan.FromSeconds(20), ct);
            if (window is null)
            {
                return Fail(
                    "target-window-visible",
                    "no top-level window for the target file appeared within 20s",
                    task, started, targetPid);
            }

            targetPid = SafeProcessId(window);
            var hwnd = SafeWindowHandle(window);
            SpikeLog.Write("target.window", "found target window", new
            {
                task.TaskId,
                pid = targetPid,
                hwnd = hwnd.ToInt64(),
                name = SafeName(window),
            });

            var focused = NativeInput.Focus(hwnd);
            SpikeLog.Write("target.focus", focused ? "foreground acquired" : "foreground refused", new
            {
                task.TaskId,
                focused,
            });
            if (!focused)
            {
                return Fail(
                    "target-foreground",
                    "could not bring the target window to the foreground; input would be delivered blind",
                    task, started, targetPid);
            }

            // Settle: the editor control has to have keyboard focus, not just the frame.
            Thread.Sleep(600);

            // Type, then read the editor back and retype if what landed is not what was sent.
            // The retry is not defensive padding — the single-batch injection bug above
            // produces a plausible-looking wrong result, so the driver has to check its own
            // work before it is entitled to call Ctrl+S.
            var inTree = new Readback(false, "not-attempted", "");
            for (var attempt = 1; attempt <= 3 && !inTree.Contains; attempt++)
            {
                // Select-all-then-type replaces the buffer, so a partial previous attempt
                // cannot leave debris that accidentally satisfies the postcondition.
                NativeInput.Chord(NativeInput.VkControl, NativeInput.VkA);
                Thread.Sleep(100);

                if (!NativeInput.TypeText(task.ExpectedText))
                {
                    return Fail(
                        "input-injection",
                        $"SendInput delivered {NativeInput.LastInjected} events of an expected batch",
                        task, started, targetPid);
                }

                Thread.Sleep(300);
                inTree = ReadBackFromTree(window, task.ExpectedText);
                SpikeLog.Write("target.typed", $"attempt {attempt}", new
                {
                    task.TaskId,
                    attempt,
                    uia_contains_text = inTree.Contains,
                    uia_source = inTree.Source,
                    uia_sample = inTree.Sample,
                    expected = task.ExpectedText,
                });
            }

            if (!inTree.Contains)
            {
                DumpTree(window, task.TaskId);
                return Fail(
                    "input-fidelity",
                    "the editor's own text never matched what was typed, after 3 attempts",
                    task, started, targetPid);
            }

            NativeInput.Chord(NativeInput.VkControl, NativeInput.VkS);
            var onDisk = WaitForFileContent(task.TargetPath, task.ExpectedText, TimeSpan.FromSeconds(10), ct);
            if (!onDisk)
            {
                DumpTree(window, task.TaskId);
            }

            SpikeLog.Write("target.postcondition", "readings taken", new
            {
                task.TaskId,
                file_contains_text = onDisk,
                uia_contains_text = inTree.Contains,
                uia_source = inTree.Source,
            });

            var ok = onDisk && inTree.Contains;
            var observed = $"file={(onDisk ? "contains" : "missing")}; uia[{inTree.Source}]={(inTree.Contains ? "contains" : "missing")}";

            return new DriveOutcome(
                ok,
                "typed text is present both in the saved file on disk and in the editor's UIA text",
                observed,
                task.ExpectedText,
                Environment.TickCount64 - started,
                ok ? null : "one or both readings did not match",
                targetPid);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            SpikeLog.WriteError("target.error", task.TaskId, ex);
            return new DriveOutcome(
                false, "target application drive", "<exception>", task.ExpectedText,
                Environment.TickCount64 - started, $"{ex.GetType().Name}: {ex.Message}", targetPid);
        }
        finally
        {
            CloseOurTab(targetPid);
        }
    }

    private static DriveOutcome Fail(
        string postcondition, string error, RunTaskPayload task, long started, int pid) =>
        new(false, postcondition, "<not reached>", task.ExpectedText,
            Environment.TickCount64 - started, error, pid);

    /// <summary>
    /// Locate the target window.
    ///
    /// Matching by process id alone is not reliable on current Windows: <c>notepad.exe</c> in
    /// System32 can hand off to a packaged app, so the process this companion started may exit
    /// immediately while the real window belongs to a different pid. Title matching is
    /// therefore the primary strategy and pid matching the fallback, not the other way round.
    /// </summary>
    private static AutomationElement? WaitForWindow(
        string targetPath, Process? launched, TimeSpan timeout, CancellationToken ct)
    {
        var stem = Path.GetFileNameWithoutExtension(targetPath);
        var fileName = Path.GetFileName(targetPath);
        var deadline = Environment.TickCount64 + (long)timeout.TotalMilliseconds;

        while (Environment.TickCount64 < deadline && !ct.IsCancellationRequested)
        {
            try
            {
                var windows = AutomationElement.RootElement.FindAll(
                    TreeScope.Children, Condition.TrueCondition);

                foreach (AutomationElement window in windows)
                {
                    var name = SafeName(window);
                    if (name.Contains(stem, StringComparison.OrdinalIgnoreCase)
                        || name.Contains(fileName, StringComparison.OrdinalIgnoreCase))
                    {
                        return window;
                    }
                }

                if (launched is { HasExited: false })
                {
                    foreach (AutomationElement window in windows)
                    {
                        if (SafeProcessId(window) == launched.Id)
                        {
                            return window;
                        }
                    }
                }
            }
            catch (ElementNotAvailableException)
            {
                // The tree changed underneath the walk; try again.
            }

            Thread.Sleep(250);
        }

        return null;
    }

    private static bool WaitForFileContent(string path, string expected, TimeSpan timeout, CancellationToken ct)
    {
        var deadline = Environment.TickCount64 + (long)timeout.TotalMilliseconds;
        while (Environment.TickCount64 < deadline && !ct.IsCancellationRequested)
        {
            try
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                using var reader = new StreamReader(stream);
                if (reader.ReadToEnd().Contains(expected, StringComparison.Ordinal))
                {
                    return true;
                }
            }
            catch (IOException)
            {
                // The editor is mid-save and holds the file; that is expected, keep polling.
            }

            Thread.Sleep(200);
        }

        return false;
    }

    internal sealed record Readback(bool Contains, string Source, string Sample);

    /// <summary>
    /// Read the editor's text back out of the automation tree. Tries the value pattern first
    /// and the text pattern second because different Notepad generations expose different ones.
    ///
    /// Returns what it actually read, not just whether it matched. "Did not match" and "could
    /// not find the editor" are different failures with different consequences for the design,
    /// and a bare boolean cannot tell them apart.
    /// </summary>
    private static Readback ReadBackFromTree(AutomationElement window, string expected)
    {
        var found = false;
        var sample = "";

        foreach (var controlType in new[] { ControlType.Document, ControlType.Edit })
        {
            AutomationElement? editor;
            try
            {
                editor = window.FindFirst(
                    TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, controlType));
            }
            catch (ElementNotAvailableException)
            {
                continue;
            }

            if (editor is null)
            {
                continue;
            }

            found = true;

            foreach (var (name, pattern, read) in new (string, AutomationPattern, Func<object, string>)[]
                     {
                         ("ValuePattern", ValuePattern.Pattern, p => ((ValuePattern)p).Current.Value),
                         ("TextPattern", TextPattern.Pattern, p => ((TextPattern)p).DocumentRange.GetText(-1)),
                     })
            {
                if (TryPattern(editor, pattern, read) is not { } text)
                {
                    continue;
                }

                if (text.Length > 0)
                {
                    sample = Truncate(text.ReplaceLineEndings("\\n"), 120);
                }

                if (text.Contains(expected, StringComparison.Ordinal))
                {
                    return new Readback(true, $"{controlType.ProgrammaticName}/{name}", sample);
                }
            }
        }

        return new Readback(false, found ? "editor-found-text-mismatch" : "editor-not-found", sample);
    }

    /// <summary>
    /// Record what the automation tree actually contains under the target window.
    ///
    /// Only runs when a readback failed, and it exists because "we could not find the editor"
    /// is not a usable finding — "the editor is a <c>RichEditBox</c> exposing neither
    /// ValuePattern nor TextPattern" is. Bounded in breadth and depth so a pathological tree
    /// cannot turn a diagnostic into a hang.
    /// </summary>
    private static void DumpTree(AutomationElement window, string taskId)
    {
        var nodes = new List<object>();

        void Walk(AutomationElement element, int depth)
        {
            if (depth > 4 || nodes.Count >= 60)
            {
                return;
            }

            try
            {
                foreach (AutomationElement child in element.FindAll(TreeScope.Children, Condition.TrueCondition))
                {
                    if (nodes.Count >= 60)
                    {
                        return;
                    }

                    var patterns = new List<string>();
                    try
                    {
                        foreach (var pattern in child.GetSupportedPatterns())
                        {
                            patterns.Add(pattern.ProgrammaticName);
                        }
                    }
                    catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException)
                    {
                        patterns.Add("<unavailable>");
                    }

                    nodes.Add(new
                    {
                        depth,
                        control = SafeControlType(child),
                        name = Truncate(SafeName(child), 60),
                        automation_id = SafeAutomationId(child),
                        class_name = SafeClassName(child),
                        patterns,
                    });

                    Walk(child, depth + 1);
                }
            }
            catch (ElementNotAvailableException)
            {
                // The tree moved under us; whatever we already collected is still useful.
            }
        }

        Walk(window, 0);
        SpikeLog.Write("target.tree", "automation tree under the target window", new
        {
            TaskId = taskId,
            root = SafeName(window),
            nodes,
        });
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max] + "...";

    private static string SafeControlType(AutomationElement element)
    {
        try
        {
            return element.Current.ControlType.ProgrammaticName;
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException)
        {
            return "<unavailable>";
        }
    }

    private static string SafeClassName(AutomationElement element)
    {
        try
        {
            return element.Current.ClassName ?? "";
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException)
        {
            return "";
        }
    }

    private static string SafeAutomationId(AutomationElement element)
    {
        try
        {
            return element.Current.AutomationId ?? "";
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException)
        {
            return "";
        }
    }

    private static string? TryPattern(
        AutomationElement element, AutomationPattern pattern, Func<object, string> read)
    {
        try
        {
            return element.TryGetCurrentPattern(pattern, out var instance) ? read(instance) : null;
        }
        catch (Exception ex) when (ex is InvalidOperationException or ElementNotAvailableException)
        {
            return null;
        }
    }

    /// <summary>
    /// Close the tab this task opened — and nothing else.
    ///
    /// Killing the target process is tempting and wrong. Windows 11 Notepad is a single
    /// long-lived instance shared with whatever the human already had open, so terminating it
    /// destroys unrelated unsaved work that the spike has no business touching. The presence
    /// design has the same property in the large: the companion shares a desktop with a real
    /// user's applications, so "clean up after yourself" has to mean the narrowest possible
    /// action.
    ///
    /// Ctrl+W is only sent while our own window is verified to be in the foreground; if focus
    /// has moved elsewhere the tab is simply left open, because a stray Ctrl+W would close
    /// someone else's document.
    /// </summary>
    private static void CloseOurTab(int pid)
    {
        if (pid <= 0)
        {
            return;
        }

        try
        {
            var window = AutomationElement.RootElement.FindFirst(
                TreeScope.Children,
                new PropertyCondition(AutomationElement.ProcessIdProperty, pid));

            if (window is null || !NativeInput.Focus(SafeWindowHandle(window)))
            {
                SpikeLog.Write("target.tab_left_open", "target window not in the foreground; not sending Ctrl+W");
                return;
            }

            NativeInput.Chord(NativeInput.VkControl, NativeInput.VkW);
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException
                                       or ArgumentException)
        {
            SpikeLog.WriteError("target.tab_close.failed", "could not close the target tab", ex);
        }
    }

    private static string SafeName(AutomationElement element)
    {
        try
        {
            return element.Current.Name ?? "";
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException)
        {
            return "";
        }
    }

    private static int SafeProcessId(AutomationElement element)
    {
        try
        {
            return element.Current.ProcessId;
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException)
        {
            return 0;
        }
    }

    private static IntPtr SafeWindowHandle(AutomationElement element)
    {
        try
        {
            return new IntPtr(element.Current.NativeWindowHandle);
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException)
        {
            return IntPtr.Zero;
        }
    }
}
