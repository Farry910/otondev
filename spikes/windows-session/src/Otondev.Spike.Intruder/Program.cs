using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using Otondev.Spike.Common;

namespace Otondev.Spike.Intruder;

/// <summary>
/// The unauthorized local caller.
///
/// The S17 criterion is "IPC ACLs hold against an unauthorized local caller", and the honest way
/// to test it is to write the attacker as if you meant it: connect to the supervisor pipe, and —
/// separately — get there first and impersonate the supervisor. Both run as an ordinary
/// unprivileged user, because that is the threat: not an administrator, who has already won, but
/// any other process on the box.
/// </summary>
public static class Program
{
    private const string Component = "intruder";

    public static int Main(string[] args)
    {
        if (args.Contains("--squat"))
        {
            return Squat(args);
        }

        if (args.Contains("--acl-matrix"))
        {
            return AclMatrix();
        }

        return Knock(args.Contains("--pipe") ? args[Array.IndexOf(args, "--pipe") + 1] : Ipc.PipeName);
    }

    /// <summary>Try to talk to the supervisor. Expected result: refused.</summary>
    private static int Knock(string pipeName)
    {
        using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut);
        try
        {
            client.Connect(2000);
        }
        catch (UnauthorizedAccessException ex)
        {
            Evidence.Record(Component, "connect-denied-by-acl", Outcome.Pass,
                $"kernel refused the connect before any application code ran: {ex.Message}",
                criterion: "an unauthorized local caller is rejected");
            return 0;
        }
        catch (TimeoutException)
        {
            Evidence.Record(Component, "connect-timeout", Outcome.Info,
                $"no pipe named {pipeName} to attack");
            return 1;
        }

        // Connected. That is only acceptable if the server then throws us off; anything we can
        // do after this point is a real finding.
        Evidence.Record(Component, "connect-allowed", Outcome.Info,
            $"kernel allowed the connect to {pipeName}; testing whether the server rejects us");

        try
        {
            var cts = new CancellationTokenSource(3000);
            Ipc.WriteLineAsync(client, new Ipc.Message("health", "intrude", null), cts.Token).GetAwaiter().GetResult();
            var reply = Ipc.ReadLineAsync(client, cts.Token).GetAwaiter().GetResult();

            if (reply is null)
            {
                Evidence.Record(Component, "server-rejected-caller", Outcome.Pass,
                    "server disconnected us without answering — application-layer allow-list held",
                    criterion: "an unauthorized local caller is rejected");
                return 0;
            }

            Evidence.Record(Component, "server-answered-intruder", Outcome.Fail,
                $"an unauthorized caller got a real answer: {Truncate(reply.Payload ?? reply.Op, 160)}",
                criterion: "an unauthorized local caller is rejected");
            return 1;
        }
        catch (Exception ex)
        {
            Evidence.Record(Component, "server-rejected-caller", Outcome.Pass,
                $"no usable answer for the intruder ({ex.GetType().Name})",
                criterion: "an unauthorized local caller is rejected");
            return 0;
        }
    }

    /// <summary>
    /// Get there first.
    ///
    /// This is the attack a pipe ACL cannot stop, because our pipe is the one that exists. It is
    /// only defeated by the client checking who owns the pipe before it says anything — which is
    /// what the companion does, and what this proves.
    /// </summary>
    private static int Squat(string[] args)
    {
        var seconds = args.Contains("--seconds") && int.TryParse(args[Array.IndexOf(args, "--seconds") + 1], out var s)
            ? s : 30;

        var security = new PipeSecurity();
        security.SetOwner(WindowsIdentity.GetCurrent().User!);
        // Wide open on purpose: the squatter wants victims.
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
            PipeAccessRights.ReadWrite, AccessControlType.Allow));

        NamedPipeServerStream server;
        try
        {
            server = Ipc.CreateServer(security, Ipc.PipeName);
        }
        catch (IOException)
        {
            Evidence.Record(Component, "squat-blocked", Outcome.Info,
                $"could not create {Ipc.PipeName}: the real supervisor already owns it");
            return 1;
        }

        Evidence.Record(Component, "squat-established", Outcome.Info,
            $"rogue pipe {Ipc.PipeName} created and owned by {IpcClient.Describe(WindowsIdentity.GetCurrent().User!)}; " +
            $"waiting {seconds}s for a victim");

        using (server)
        {
            var connected = server.WaitForConnectionAsync(new CancellationTokenSource(seconds * 1000).Token);
            try
            {
                connected.GetAwaiter().GetResult();
            }
            catch (OperationCanceledException)
            {
                Evidence.Record(Component, "squat-no-victim", Outcome.Pass,
                    $"no client connected to the rogue pipe in {seconds}s — clients verified the owner and refused",
                    criterion: "local IPC is mutually authenticated");
                return 0;
            }

            Evidence.Record(Component, "squat-victim-connected", Outcome.Fail,
                "a client connected to the rogue pipe — server authentication is missing on the client side",
                criterion: "local IPC is mutually authenticated");
            return 1;
        }
    }

    /// <summary>
    /// The ACL, tested four ways in one process.
    ///
    /// A single "the intruder was denied" result is easy to fake by accident — a typo in the pipe
    /// name denies everyone. Running the allow case alongside the deny cases is what makes the
    /// deny cases mean something.
    /// </summary>
    private static int AclMatrix()
    {
        var me = WindowsIdentity.GetCurrent().User!;
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var failures = 0;

        failures += Expect(
            "acl:granted-to-LocalSystem-only",
            pipeName: "otondev-spike-acl-system-only",
            grant: [system],
            shouldConnect: false,
            because: "this process is not LocalSystem, so the kernel must refuse it");

        failures += Expect(
            "acl:granted-to-caller",
            pipeName: "otondev-spike-acl-self",
            grant: [me],
            shouldConnect: true,
            because: "the allow path must work, or the deny results above prove nothing");

        failures += Expect(
            "acl:granted-to-Administrators-only",
            pipeName: "otondev-spike-acl-admins-only",
            grant: [new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null)],
            shouldConnect: Native.IsCurrentProcessElevated(),
            because: "an unelevated caller does not carry the Administrators SID in its token");

        failures += Expect(
            "acl:granted-to-nobody-but-owner",
            pipeName: "otondev-spike-acl-empty",
            grant: [],
            shouldConnect: false,
            because: "an empty DACL grants nothing, not everything");

        Evidence.Record(Component, "acl-matrix", failures == 0 ? Outcome.Pass : Outcome.Fail,
            failures == 0
                ? "all four ACL cases behaved as specified"
                : $"{failures} of 4 ACL cases did not behave as specified",
            criterion: "local IPC is ACL-restricted; an unauthorized local caller is rejected");

        return failures;
    }

    private static int Expect(
        string check, string pipeName, SecurityIdentifier[] grant, bool shouldConnect, string because)
    {
        var security = Ipc.RestrictTo(grant);
        using var server = Ipc.CreateServer(security, pipeName, maxInstances: 1);
        var accepting = server.WaitForConnectionAsync(new CancellationTokenSource(2000).Token);

        var connected = false;
        var detail = string.Empty;

        using (var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut))
        {
            try
            {
                client.Connect(1000);
                connected = true;
                detail = "connected";
            }
            catch (Exception ex)
            {
                detail = $"{ex.GetType().Name}: {ex.Message.Trim()}";
            }
        }

        try { accepting.GetAwaiter().GetResult(); } catch (Exception) { /* expected on the deny cases */ }

        var ok = connected == shouldConnect;
        Evidence.Record(Component, check, ok ? Outcome.Pass : Outcome.Fail,
            $"expected connect={shouldConnect} ({because}); got connect={connected} — {detail}",
            criterion: "local IPC is ACL-restricted; an unauthorized local caller is rejected");

        return ok ? 0 : 1;
    }

    private static string Truncate(string value, int max) => value.Length <= max ? value : value[..max] + "...";
}
