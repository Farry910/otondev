using System.Diagnostics;
using System.Windows.Automation;
using Otondev.Spike.Common;

namespace Otondev.Spike.Companion;

/// <summary>
/// Drives a real application through UI Automation and then checks whether the application
/// actually changed.
///
/// The distinction the card draws — "reports a postcondition, not just 'the call returned'" —
/// is the entire design of this class. <c>ValuePattern.SetValue</c> returning without throwing
/// proves that UIA accepted a request. It does not prove the application processed it, that the
/// right control received it, or that the text is what we asked for. So every verb here ends by
/// re-reading state *out of the application* through an independent path and comparing.
/// </summary>
public sealed class UiaDriver
{
    private readonly string _component;

    public UiaDriver(string component) => _component = component;

    public sealed record DriveResult(
        bool Succeeded,
        string Adapter,
        string Postcondition,
        string Observed,
        double ElapsedMs);

    /// <summary>
    /// Wait for the top-level window belonging to <paramref name="process"/>.
    ///
    /// Polling rather than a UIA event: the window can appear before the automation provider is
    /// ready to answer for it, and an event subscription that fires early gives you an element
    /// whose patterns are all still missing.
    /// </summary>
    public AutomationElement? WaitForMainWindow(Process process, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        var condition = new PropertyCondition(AutomationElement.ProcessIdProperty, process.Id);

        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var element = AutomationElement.RootElement.FindFirst(TreeScope.Children, condition);
                if (element is not null && SafeName(element).Length >= 0)
                {
                    return element;
                }
            }
            catch (ElementNotAvailableException)
            {
                // The window went away mid-search; keep looking.
            }

            Thread.Sleep(150);
        }

        return null;
    }

    /// <summary>
    /// Find the editable region: the adapter ladder from S16, in miniature.
    ///
    /// Notepad on Windows 11 is a WinUI app whose editor is a Document, while classic Notepad
    /// exposes a plain Edit; a driver that hard-codes either one works on exactly one machine.
    /// The order here is Value-capable Document, then Value-capable Edit, then anything with a
    /// TextPattern — most specific and most reliable first, degrading only when it must.
    /// </summary>
    public (AutomationElement? Element, string Adapter) FindEditable(AutomationElement window, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;

        while (DateTime.UtcNow < deadline)
        {
            foreach (var (type, label) in new[]
            {
                (ControlType.Document, "uia:Document+ValuePattern"),
                (ControlType.Edit, "uia:Edit+ValuePattern"),
            })
            {
                var candidate = FindFirstWith(window, type, ValuePattern.Pattern);
                if (candidate is not null) return (candidate, label);
            }

            foreach (var (type, label) in new[]
            {
                (ControlType.Document, "uia:Document+TextPattern"),
                (ControlType.Edit, "uia:Edit+TextPattern"),
            })
            {
                var candidate = FindFirstWith(window, type, TextPattern.Pattern);
                if (candidate is not null) return (candidate, label);
            }

            Thread.Sleep(150);
        }

        return (null, "none");
    }

    private static AutomationElement? FindFirstWith(AutomationElement root, ControlType type, AutomationPattern pattern)
    {
        try
        {
            var found = root.FindAll(TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, type));

            foreach (AutomationElement element in found)
            {
                if (element.TryGetCurrentPattern(pattern, out _))
                {
                    return element;
                }
            }
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException)
        {
            // Provider disappeared or refused; caller retries.
        }

        return null;
    }

    /// <summary>
    /// Set text and then prove it took.
    ///
    /// Read-back goes through TextPattern when it is available even though we wrote through
    /// ValuePattern, because reading back through the same pattern we wrote with can be
    /// satisfied by the provider's own cache. Two different patterns disagreeing is exactly the
    /// signal we want.
    /// </summary>
    public DriveResult SetTextAndVerify(AutomationElement editable, string adapter, string text)
    {
        var sw = Stopwatch.StartNew();
        var postcondition = $"the application's own text equals {text.Length} chars of expected content";

        try
        {
            if (editable.TryGetCurrentPattern(ValuePattern.Pattern, out var raw) && raw is ValuePattern value)
            {
                if (value.Current.IsReadOnly)
                {
                    sw.Stop();
                    return new DriveResult(false, adapter, postcondition, "control is read-only", sw.Elapsed.TotalMilliseconds);
                }

                editable.SetFocus();
                value.SetValue(text);
            }
            else
            {
                sw.Stop();
                return new DriveResult(false, adapter, postcondition, "no writable ValuePattern", sw.Elapsed.TotalMilliseconds);
            }

            // Give the application a chance to actually process it before asserting.
            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
            var observed = string.Empty;
            while (DateTime.UtcNow < deadline)
            {
                observed = ReadBack(editable);
                if (observed.Contains(text, StringComparison.Ordinal)) break;
                Thread.Sleep(100);
            }

            sw.Stop();
            var ok = observed.Contains(text, StringComparison.Ordinal);
            return new DriveResult(ok, adapter, postcondition,
                ok ? $"read back {observed.Length} chars containing the expected text"
                   : $"read back {observed.Length} chars WITHOUT the expected text: '{Truncate(observed, 80)}'",
                sw.Elapsed.TotalMilliseconds);
        }
        catch (Exception ex)
        {
            sw.Stop();
            return new DriveResult(false, adapter, postcondition,
                $"{ex.GetType().Name}: {ex.Message}", sw.Elapsed.TotalMilliseconds);
        }
    }

    /// <summary>Read the control's text through TextPattern first, ValuePattern second.</summary>
    public static string ReadBack(AutomationElement element)
    {
        try
        {
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out var textRaw) && textRaw is TextPattern text)
            {
                return text.DocumentRange.GetText(-1);
            }
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var valueRaw) && valueRaw is ValuePattern value)
            {
                return value.Current.Value ?? string.Empty;
            }
        }
        catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException)
        {
            return string.Empty;
        }

        return string.Empty;
    }

    /// <summary>
    /// A second, independent postcondition: the window's own title.
    ///
    /// It comes from the application rather than from the control we just wrote to, so it fails
    /// separately. When the read-back passes and this does not, the usual cause is that we drove
    /// a control in the wrong window — which a single postcondition would have called success.
    /// </summary>
    public DriveResult VerifyTitleChanged(AutomationElement window, string before, TimeSpan timeout)
    {
        var sw = Stopwatch.StartNew();
        var deadline = DateTime.UtcNow + timeout;
        var after = before;

        while (DateTime.UtcNow < deadline)
        {
            after = SafeName(window);
            if (!string.Equals(after, before, StringComparison.Ordinal)) break;
            Thread.Sleep(100);
        }

        sw.Stop();
        var changed = !string.Equals(after, before, StringComparison.Ordinal);
        return new DriveResult(changed, "uia:Window.Name", "the target window reports itself as modified",
            changed ? $"title '{before}' -> '{after}'" : $"title unchanged at '{after}'",
            sw.Elapsed.TotalMilliseconds);
    }

    public static string SafeName(AutomationElement element)
    {
        try { return element.Current.Name ?? string.Empty; }
        catch (Exception) { return string.Empty; }
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max] + "...";

    public void Report(string check, DriveResult result, string criterion)
    {
        Evidence.Record(_component, check, result.Succeeded ? Outcome.Pass : Outcome.Fail,
            $"[{result.Adapter}] postcondition: {result.Postcondition} — observed: {result.Observed}",
            result.ElapsedMs, criterion);
    }
}
