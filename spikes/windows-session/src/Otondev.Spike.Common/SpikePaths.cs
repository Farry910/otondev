namespace Otondev.Spike.Common;

/// <summary>
/// Every process in the spike — the session-0 service, the interactive companion, and the
/// probe — has to agree on where state lives, and they do not share a user profile. The
/// service runs as LocalSystem, so <c>%LOCALAPPDATA%</c> and friends resolve to different
/// places for each. Everything therefore hangs off a single machine-wide directory whose
/// ACL is set once by the install script.
/// </summary>
public static class SpikePaths
{
    /// <summary>Machine-wide root. Same string for LocalSystem and for the interactive user.</summary>
    public static string Root { get; } =
        Environment.GetEnvironmentVariable("OTONDEV_SPIKE_ROOT")
        ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "OtondevSpike");

    /// <summary>Append-only JSONL event stream. The measurements are derived from this file.</summary>
    public static string EventLog => Path.Combine(Root, "events.jsonl");

    /// <summary>Scratch for the target-application postcondition file.</summary>
    public static string WorkDir => Path.Combine(Root, "work");

    /// <summary>Where the companion binary is expected to live, for launch and for identity checks.</summary>
    public static string CompanionExe => Path.Combine(BinDir, "Otondev.Spike.Companion.exe");

    public static string ServiceExe => Path.Combine(BinDir, "Otondev.Spike.Service.exe");

    /// <summary>
    /// Directory holding the deployed binaries. Defaults to the directory of the running
    /// process so the pair also works straight out of a build output folder.
    /// </summary>
    public static string BinDir { get; } =
        Environment.GetEnvironmentVariable("OTONDEV_SPIKE_BIN")
        ?? AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);

    public const string ServiceName = "OtondevSpikeSupervisor";

    /// <summary>
    /// Named pipe the companion talks to. Deliberately <b>not</b> under <c>Global\</c>-style
    /// naming games: pipe names are already machine-global, which is exactly why the pipe
    /// needs both a DACL and an application-level identity check on each end.
    /// </summary>
    public const string PipeName = "otondev-spike-supervisor";

    public static void EnsureDirectories()
    {
        Directory.CreateDirectory(Root);
        Directory.CreateDirectory(WorkDir);
    }
}
