using System.IO.Pipes;
using Otondev.Spike.Common;

namespace Otondev.Spike.Companion;

/// <summary>The companion's end of an already-verified supervisor pipe.</summary>
public sealed class SupervisorChannel : IDisposable
{
    private readonly NamedPipeClientStream _stream;
    private readonly SemaphoreSlim _writeGate = new(1, 1);

    public SupervisorChannel(NamedPipeClientStream stream) => _stream = stream;

    public async Task SendAsync(string op, string? payload, CancellationToken ct)
    {
        await _writeGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await Ipc.WriteLineAsync(_stream, new Ipc.Message(op, Guid.NewGuid().ToString("n")[..8], payload), ct)
                .ConfigureAwait(false);
        }
        finally
        {
            _writeGate.Release();
        }
    }

    public void Dispose()
    {
        _writeGate.Dispose();
        _stream.Dispose();
    }
}
