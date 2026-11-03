namespace TaskSync.Desktop;

internal static class Program
{
    private const string MutexName = @"Local\TaskSync.Desktop.SingleInstance";
    private const string ShowEventName = @"Local\TaskSync.Desktop.Show";

    /// <summary>
    /// Usage: TaskSync.exe [--minimized] [--url https://your-tasksync-host]
    /// --url is remembered; only https (or http://localhost for development) is accepted.
    /// </summary>
    [STAThread]
    private static void Main(string[] args)
    {
        using var mutex = new Mutex(initiallyOwned: true, MutexName, out var isFirst);
        if (!isFirst)
        {
            // Already running: bring the existing widget to the front instead of starting twice.
            try
            {
                using var signal = EventWaitHandle.OpenExisting(ShowEventName);
                signal.Set();
            }
            catch (WaitHandleCannotBeOpenedException)
            {
            }
            return;
        }

        ApplicationConfiguration.Initialize();
        var settings = AppSettings.Load();
        var url = ArgValue(args, "--url");
        if (url is not null)
        {
            if (!AppSettings.IsAllowedBaseUrl(url))
            {
                MessageBox.Show($"Ignoring --url {url}: TaskSync only connects to https:// addresses (or http://localhost for development).", "TaskSync");
            }
            else
            {
                settings.BaseUrl = url.TrimEnd('/');
                settings.Save();
            }
        }

        var minimized = args.Contains("--minimized", StringComparer.OrdinalIgnoreCase);
        using var controller = new HostController(settings, minimized);

        using var showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
        var listener = new Thread(() =>
        {
            while (showSignal.WaitOne())
            {
                if (controller.Exiting) return;
                controller.MainForm?.BeginInvoke(controller.ShowWidget);
            }
        })
        { IsBackground = true, Name = "TaskSync single-instance listener" };
        listener.Start();

        Application.Run(controller);
    }

    private static string? ArgValue(string[] args, string name)
    {
        var i = Array.FindIndex(args, a => a.Equals(name, StringComparison.OrdinalIgnoreCase));
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
