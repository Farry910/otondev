using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using Otondev.Spike.Common;

namespace Otondev.Spike.Probe;

/// <summary>
/// The two adversarial halves of exit criterion 5.
///
/// <see cref="Intrude"/> attacks the supervisor: a process the user is perfectly entitled to
/// run tries to take the companion's place on the channel. It passes the pipe DACL — same user,
/// same session — so if it gets in, "ACL-restricted" was never a real control on a
/// single-user presence desktop.
///
/// <see cref="Squat"/> attacks the companion: an unprivileged process claims the well-known
/// pipe name before the supervisor does. Nothing in Windows reserves pipe names, so this
/// always succeeds at the name level; the only question is whether the companion notices it is
/// talking to an impostor.
/// </summary>
internal static class SecurityTests
{
    internal static async Task<int> Intrude(CancellationToken ct)
    {
        Console.WriteLine($"connecting to \\\\.\\pipe\\{SpikePaths.PipeName} as an unauthorized image...");
        var identity = TokenInfo.Describe();
        SpikeLog.Write("intruder.begin", "unauthorized local caller test", new
        {
            identity.UserName,
            identity.UserSid,
            image = Environment.ProcessPath,
        });

        using var client = new NamedPipeClientStream(
            ".", SpikePaths.PipeName, PipeDirection.InOut,
            PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);

        try
        {
            await client.ConnectAsync(5000, ct);
        }
        catch (TimeoutException)
        {
            Console.WriteLine("  RESULT: could not connect — no supervisor pipe is listening.");
            SpikeLog.Write("intruder.no_pipe", "no supervisor pipe to attack");
            return 1;
        }
        catch (UnauthorizedAccessException ex)
        {
            // The strongest possible outcome: refused by the kernel at open time.
            Console.WriteLine("  RESULT: DENIED BY DACL at connect time.");
            SpikeLog.Write("intruder.denied_by_dacl", "pipe DACL refused the caller", new
            {
                error = ex.Message,
            });
            return 0;
        }

        Console.WriteLine("  connected (expected: the DACL allows this user)");
        DumpAcl(client);

        using var channel = new PipeChannel(client);
        try
        {
            await channel.SendAsync(
                Wire.Hello,
                new HelloPayload(
                    "intruder", Environment.ProcessId, identity.SessionId, identity.UserName,
                    identity.UserSid, identity.IsElevated, identity.IsAdministrator,
                    identity.IntegrityLevel, identity.WindowStation, identity.Desktop,
                    Environment.TickCount64, Environment.TickCount64, "intruder"),
                ct);
        }
        catch (IOException)
        {
            // The supervisor decided before we finished talking. Being hung up on mid-sentence
            // is a rejection, and the strictest kind — worth recording as success, not as a
            // probe crash.
            Console.WriteLine("  RESULT: REJECTED — supervisor hung up before accepting any input.");
            SpikeLog.Write("intruder.rejected", "supervisor closed the pipe during the intruder's first write");
            return 0;
        }

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(5));

        try
        {
            while (true)
            {
                var frame = await channel.ReceiveAsync(deadline.Token);
                if (frame is null)
                {
                    // Server hung up without engaging: also a rejection, just a terser one.
                    Console.WriteLine("  RESULT: REJECTED — supervisor closed the channel without serving it.");
                    SpikeLog.Write("intruder.rejected", "supervisor closed the channel");
                    return 0;
                }

                if (frame.Value.Type == Wire.Rejected)
                {
                    var reason = frame.Value.Payload.TryGetProperty("reason", out var r) ? r.GetString() : null;
                    Console.WriteLine($"  RESULT: REJECTED — {reason}");
                    SpikeLog.Write("intruder.rejected", reason ?? "rejected", new { reason });
                    return 0;
                }

                // Anything else means the supervisor started treating us as the companion.
                Console.WriteLine($"  RESULT: *** ACCEPTED *** — supervisor sent '{frame.Value.Type}'. THIS IS A DEFECT.");
                SpikeLog.Write("intruder.accepted", $"supervisor served frame '{frame.Value.Type}'", new
                {
                    frame = frame.Value.Type,
                    severity = "authorization bypass",
                });
                return 2;
            }
        }
        catch (OperationCanceledException)
        {
            Console.WriteLine("  RESULT: REJECTED — no response within 5s and no task was ever issued.");
            SpikeLog.Write("intruder.rejected", "silent rejection (no frames within 5s)");
            return 0;
        }
        catch (IOException)
        {
            Console.WriteLine("  RESULT: REJECTED — supervisor broke the connection.");
            SpikeLog.Write("intruder.rejected", "connection broken by supervisor");
            return 0;
        }
    }

    /// <summary>
    /// Read the pipe's DACL from the client side and record every ACE. This is the static half
    /// of "ACL-restricted": it shows exactly who is on the list rather than asserting a policy.
    /// </summary>
    private static void DumpAcl(NamedPipeClientStream client)
    {
        try
        {
            var security = client.GetAccessControl();
            var rules = security
                .GetAccessRules(true, true, typeof(SecurityIdentifier))
                .Cast<PipeAccessRule>()
                .Select(rule => new
                {
                    sid = rule.IdentityReference.Value,
                    account = Translate(rule.IdentityReference.Value),
                    rights = rule.PipeAccessRights.ToString(),
                    type = rule.AccessControlType.ToString(),
                })
                .ToList();

            Console.WriteLine("  pipe DACL:");
            foreach (var rule in rules)
            {
                Console.WriteLine($"    {rule.type,-5} {rule.account,-40} {rule.rights}");
            }

            SpikeLog.Write("ipc.acl.observed", "pipe DACL as seen by a connected client", new
            {
                owner = PipeAuth.GetPipeOwner(client.SafePipeHandle).Value,
                rules,
            });
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or System.ComponentModel.Win32Exception
                                       or InvalidOperationException or PrivilegeNotHeldException)
        {
            Console.WriteLine($"  pipe DACL: unreadable ({ex.GetType().Name})");
            SpikeLog.WriteError("ipc.acl.unreadable", "client could not read the DACL", ex);
        }
    }

    private static string Translate(string sid)
    {
        try
        {
            return ((NTAccount)new SecurityIdentifier(sid).Translate(typeof(NTAccount))).Value;
        }
        catch (SystemException)
        {
            return sid;
        }
    }

    /// <summary>
    /// Hold the supervisor's well-known pipe name as an unprivileged user and accept whatever
    /// connects. Anything a companion sends here is data it should never have sent.
    /// </summary>
    internal static async Task<int> Squat(TimeSpan duration, CancellationToken ct)
    {
        var identity = TokenInfo.Describe();
        Console.WriteLine($"squatting \\\\.\\pipe\\{SpikePaths.PipeName} as {identity.UserName} " +
                          $"(elevated={identity.IsElevated}) for {duration.TotalSeconds:F0}s...");

        NamedPipeServerStream server;
        try
        {
            // A default ACL, exactly what a careless or hostile process would create.
            server = new NamedPipeServerStream(
                SpikePaths.PipeName, PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        }
        catch (IOException ex)
        {
            Console.WriteLine($"  could not claim the name: {ex.Message}");
            Console.WriteLine("  (the supervisor already holds it — FirstPipeInstance did its job)");
            SpikeLog.Write("squatter.name_unavailable", "supervisor already owns the pipe name", new
            {
                error = ex.Message,
            });
            return 0;
        }

        SpikeLog.Write("squatter.listening", "rogue pipe server holds the supervisor's name", new
        {
            identity.UserName,
            identity.UserSid,
            identity.IsElevated,
            owner_will_be = identity.UserSid,
        });

        await using (server)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(duration);

            try
            {
                await server.WaitForConnectionAsync(deadline.Token);
            }
            catch (OperationCanceledException)
            {
                Console.WriteLine("  RESULT: nothing connected within the window.");
                SpikeLog.Write("squatter.no_victim", "no client connected during the squat window");
                return 0;
            }

            Console.WriteLine("  a client connected; waiting to see whether it says anything...");
            using var channel = new PipeChannel(server);
            using var replyDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            replyDeadline.CancelAfter(TimeSpan.FromSeconds(8));

            try
            {
                var frame = await channel.ReceiveAsync(replyDeadline.Token);
                if (frame is null)
                {
                    Console.WriteLine("  RESULT: DEFENDED — the client disconnected without sending anything.");
                    SpikeLog.Write("squatter.defended", "client disconnected without disclosing anything");
                    return 0;
                }

                Console.WriteLine($"  RESULT: *** LEAKED *** — client sent '{frame.Value.Type}'. THIS IS A DEFECT.");
                SpikeLog.Write("squatter.leaked", $"client sent '{frame.Value.Type}' to a rogue server", new
                {
                    frame = frame.Value.Type,
                    payload = frame.Value.Payload.ToString(),
                    severity = "server authentication bypass",
                });
                return 2;
            }
            catch (Exception ex) when (ex is OperationCanceledException or IOException)
            {
                Console.WriteLine("  RESULT: DEFENDED — the client connected but never sent a frame.");
                SpikeLog.Write("squatter.defended", "client connected, authenticated the server, and said nothing");
                return 0;
            }
        }
    }
}
