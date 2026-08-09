using System.Runtime.InteropServices;

namespace Otondev.Spike.Companion;

/// <summary>
/// Real input injection and foreground management.
///
/// <c>SendInput</c> is used rather than a UI Automation <c>ValuePattern.SetValue</c> because the
/// two prove different things. SetValue asks the application to change its own state through an
/// accessibility interface; SendInput puts events on the session's input queue exactly as a
/// human would, and it only works from a process that genuinely owns an interactive window
/// station and desktop. For a spike about whether a service-launched companion is really
/// "in the session", the second is the question worth answering — a session-0 process can
/// sometimes still reach an automation provider, but it can never inject session input.
///
/// Text is injected as <c>KEYEVENTF_UNICODE</c> scan codes so results do not depend on the
/// active keyboard layout; a layout-sensitive test would produce different postcondition text
/// on a different machine and make the measurement worthless.
/// </summary>
internal static class NativeInput
{
    private const int InputKeyboard = 1;
    private const uint KeyEventKeyUp = 0x0002;
    private const uint KeyEventUnicode = 0x0004;

    internal const ushort VkControl = 0x11;
    internal const ushort VkEnd = 0x23;
    internal const ushort VkS = 0x53;

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HardwareInput
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
        [FieldOffset(0)] public HardwareInput Hardware;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public int type;
        public InputUnion u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, Input[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private const int SwRestore = 9;

    /// <summary>Number of events the last injection actually delivered; 0 means the desktop refused us.</summary>
    internal static uint LastInjected { get; private set; }

    internal const ushort VkA = 0x41;
    internal const ushort VkW = 0x57;

    /// <summary>
    /// Type <paramref name="text"/> in small batches with a pause between them.
    ///
    /// Sending the whole string in one <c>SendInput</c> call looks correct and is not. Measured
    /// against Windows 11 Notepad, a 38-character single-batch injection produced 38 characters
    /// of which only the first 14 were right and the remaining 24 were all copies of the final
    /// character — right length, wrong content. <c>SendInput</c> reported full success for that,
    /// which is precisely the "the call returned" failure mode this spike exists to distinguish
    /// from a real postcondition. Batching lets the target's message pump drain between groups.
    /// </summary>
    /// <summary>
    /// Injection rate, overridable so the spike can find the threshold empirically rather than
    /// hard-coding a number that happened to work once on one machine. Reported in the findings
    /// because any UI driver built on this design inherits the constraint.
    /// </summary>
    internal static int BatchSize { get; } =
        int.TryParse(Environment.GetEnvironmentVariable("OTONDEV_SPIKE_TYPE_BATCH"), out var b) && b > 0 ? b : 1;

    internal static int PauseMs { get; } =
        int.TryParse(Environment.GetEnvironmentVariable("OTONDEV_SPIKE_TYPE_PAUSE"), out var p) && p >= 0 ? p : 25;

    internal static bool TypeText(string text) => TypeText(text, BatchSize, PauseMs);

    internal static bool TypeText(string text, int charsPerBatch, int pauseMs)
    {
        for (var offset = 0; offset < text.Length; offset += charsPerBatch)
        {
            var slice = text.AsSpan(offset, Math.Min(charsPerBatch, text.Length - offset));
            var inputs = new Input[slice.Length * 2];
            for (var i = 0; i < slice.Length; i++)
            {
                inputs[i * 2] = UnicodeKey(slice[i], up: false);
                inputs[(i * 2) + 1] = UnicodeKey(slice[i], up: true);
            }

            if (!Send(inputs))
            {
                return false;
            }

            Thread.Sleep(pauseMs);
        }

        return true;
    }

    internal static bool Chord(ushort modifier, ushort key) =>
        Send([
            VirtualKey(modifier, up: false),
            VirtualKey(key, up: false),
            VirtualKey(key, up: true),
            VirtualKey(modifier, up: true),
        ]);

    internal static bool Press(ushort key) =>
        Send([VirtualKey(key, up: false), VirtualKey(key, up: true)]);

    private static bool Send(Input[] inputs)
    {
        if (inputs.Length == 0)
        {
            LastInjected = 0;
            return true;
        }

        LastInjected = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>());
        return LastInjected == inputs.Length;
    }

    private static Input UnicodeKey(char ch, bool up) => new()
    {
        type = InputKeyboard,
        u = new InputUnion
        {
            Keyboard = new KeyboardInput
            {
                wVk = 0,
                wScan = ch,
                dwFlags = KeyEventUnicode | (up ? KeyEventKeyUp : 0),
            },
        },
    };

    private static Input VirtualKey(ushort vk, bool up) => new()
    {
        type = InputKeyboard,
        u = new InputUnion
        {
            Keyboard = new KeyboardInput
            {
                wVk = vk,
                dwFlags = up ? KeyEventKeyUp : 0,
            },
        },
    };

    /// <summary>
    /// Bring a window to the foreground from a process that did not start in the foreground.
    ///
    /// A service-launched companion has no foreground activation right, so a bare
    /// <c>SetForegroundWindow</c> is silently ignored — the call returns and nothing moves,
    /// which would show up as "typed into the void". Attaching to the current foreground
    /// thread's input queue is the supported way out of that, and the fact that it is needed
    /// at all is itself a finding for the presence design.
    /// </summary>
    internal static bool Focus(IntPtr hWnd)
    {
        if (hWnd == IntPtr.Zero)
        {
            return false;
        }

        ShowWindow(hWnd, SwRestore);
        if (SetForegroundWindow(hWnd) && GetForegroundWindow() == hWnd)
        {
            return true;
        }

        var foreground = GetForegroundWindow();
        var foregroundThread = GetWindowThreadProcessId(foreground, out _);
        var ourThread = GetCurrentThreadId();

        var attached = foregroundThread != 0
            && foregroundThread != ourThread
            && AttachThreadInput(ourThread, foregroundThread, true);
        try
        {
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
        }
        finally
        {
            if (attached)
            {
                AttachThreadInput(ourThread, foregroundThread, false);
            }
        }

        return GetForegroundWindow() == hWnd;
    }
}
