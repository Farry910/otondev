using System.Windows.Forms;

namespace Otondev.Spike.TargetApp;

/// <summary>
/// A deliberately boring Win32 application for the companion to drive.
///
/// Its job is to be a *control* in the experimental sense. When the companion drives Notepad and
/// fails, there are at least three candidate causes: the cross-session launch put us on the
/// wrong window station, UI Automation is not working from this process, or Notepad specifically
/// is uncooperative. Driving something whose automation surface we know is sane separates the
/// first two from the third.
///
/// It reflects edits in its title bar so that the companion has a second postcondition that
/// comes from the application rather than from the control it just wrote to.
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();

        var input = new TextBox
        {
            Name = "probe-input",
            AccessibleName = "probe-input",
            Dock = DockStyle.Fill,
            Multiline = true,
        };

        var form = new Form
        {
            Text = "Otondev SP1 target — idle",
            Width = 640,
            Height = 320,
            StartPosition = FormStartPosition.CenterScreen,
        };

        input.TextChanged += (_, _) =>
            form.Text = $"Otondev SP1 target — modified ({input.TextLength} chars)";

        form.Controls.Add(input);
        Application.Run(form);
    }
}
