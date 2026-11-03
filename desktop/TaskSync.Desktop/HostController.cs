using System.Drawing;
using System.Reflection;
using Microsoft.Win32;

namespace TaskSync.Desktop;

/// <summary>
/// Owns the tray icon, widget and dashboard windows, and executes bridge requests from the web UI.
/// </summary>
public sealed class HostController : ApplicationContext
{
    public static readonly Icon AppIcon = LoadIcon();
    public static string Version =>
        Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "0.0.0";

    public AppSettings Settings { get; }
    public UrlPolicy Policy { get; }
    public HostServices Services { get; } = new();
    public AutoStart AutoStart { get; }
    public bool Exiting { get; private set; }

    private readonly NotifyIcon _tray;
    private readonly WidgetForm _widget;
    private DashboardForm? _dashboard;
    private string? _lastToastTaskId;
    private DateTime _lastToastAt = DateTime.MinValue;
    private readonly ToolStripMenuItem _topMostItem;
    private readonly ToolStripMenuItem _autoStartItem;
    private readonly ToolStripMenuItem _expandedItem;
    private readonly ToolStripMenuItem _captureItem;
    private readonly ToolStripMenuItem _desktopItem;

    public HostController(AppSettings settings, bool startMinimized, AutoStart? autoStart = null)
    {
        Settings = settings;
        Policy = new UrlPolicy(settings.BaseUrl);
        AutoStart = autoStart ?? new AutoStart();

        _topMostItem = new ToolStripMenuItem("Keep widget on top", null, (_, _) => SetAlwaysOnTop(!Settings.AlwaysOnTop)) { Checked = Settings.AlwaysOnTop };
        _autoStartItem = new ToolStripMenuItem("Start with Windows", null, (_, _) => SetAutoStart(!AutoStart.IsEnabled)) { Checked = SafeAutoStartEnabled() };
        _expandedItem = new ToolStripMenuItem("Expanded widget", null, (_, _) => SetMode(Settings.Mode == WidgetMode.Compact ? WidgetMode.Expanded : WidgetMode.Compact))
        {
            Checked = Settings.Mode == WidgetMode.Expanded,
        };
        _captureItem = new ToolStripMenuItem("Hide from screen sharing", null, (_, _) => SetHideFromCapture(!Settings.HideFromScreenCapture))
        {
            Checked = Settings.HideFromScreenCapture,
        };
        _desktopItem = new ToolStripMenuItem("Stay visible on Show desktop (Win+D)", null, (_, _) => SetStayOnDesktop(!Settings.StayOnDesktop))
        {
            Checked = Settings.StayOnDesktop,
        };
        var menu = new ContextMenuStrip { ShowImageMargin = false, RenderMode = ToolStripRenderMode.System };
        menu.Items.Add(new ToolStripMenuItem("Show TaskSync widget", null, (_, _) => ShowWidget()) { Font = new Font(menu.Font, FontStyle.Bold) });
        menu.Items.Add(new ToolStripMenuItem("Open dashboard", null, (_, _) => OpenDashboard("/")));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_expandedItem);
        menu.Items.Add(_topMostItem);
        menu.Items.Add(_captureItem);
        menu.Items.Add(_desktopItem);
        menu.Items.Add(_autoStartItem);
        menu.Items.Add(new ToolStripMenuItem("Settings", null, (_, _) => OpenDashboard("/settings")));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Exit TaskSync", null, (_, _) => Exit()));

        _tray = new NotifyIcon
        {
            Icon = AppIcon,
            Text = "TaskSync",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _tray.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) ToggleWidget();
        };
        _tray.BalloonTipClicked += (_, _) =>
        {
            if (_lastToastTaskId is { } id) OpenDashboard($"/?task={id}");
            else ShowWidget();
        };

        _widget = new WidgetForm(this);
        MainForm = _widget;
        SystemEvents.PowerModeChanged += OnPowerModeChanged;

        if (startMinimized)
        {
            // Create the window (so realtime + notifications run) without showing it.
            _ = _widget.Handle;
            _widget.Opacity = 0;
            _widget.Show();
            _widget.HideToTray();
            _widget.Opacity = 1;
        }
        else
        {
            _widget.Show();
        }
        Services.Log("started", new { version = Version, baseUrl = Settings.BaseUrl, minimized = startMinimized });
    }

    private static Icon LoadIcon()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("tasksync.ico");
        return stream is null ? SystemIcons.Application : new Icon(stream);
    }

    private bool SafeAutoStartEnabled()
    {
        try
        {
            return AutoStart.IsEnabled;
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    public HostState State => new(
        Version,
        Settings.AlwaysOnTop,
        SafeAutoStartEnabled(),
        Settings.Mode == WidgetMode.Compact ? "compact" : "expanded",
        Settings.HideFromScreenCapture,
        Settings.StayOnDesktop);

    // ---- Commands --------------------------------------------------------------

    public void ShowWidget()
    {
        if (!_widget.Visible) _widget.Show();
        if (_widget.WindowState == FormWindowState.Minimized) _widget.WindowState = FormWindowState.Normal;
        _widget.Activate();
        Native.SetForegroundWindow(_widget.Handle);
    }

    private void ToggleWidget()
    {
        if (_widget.Visible && _widget.ContainsFocus) _widget.HideToTray();
        else ShowWidget();
    }

    public void OpenDashboard(string path)
    {
        var safePath = path.StartsWith('/') && !path.StartsWith("//", StringComparison.Ordinal) ? path : "/";
        if (_dashboard is null || _dashboard.IsDisposed)
        {
            _dashboard = new DashboardForm(this, safePath);
            _dashboard.FormClosed += (_, _) => _dashboard = null;
            _dashboard.Show();
        }
        else
        {
            _dashboard.NavigateTo(safePath);
            if (_dashboard.WindowState == FormWindowState.Minimized) _dashboard.WindowState = FormWindowState.Normal;
            _dashboard.Activate();
        }
        Services.Log("openDashboard", new { path = safePath });
    }

    public void SetAlwaysOnTop(bool value)
    {
        _widget.SetAlwaysOnTop(value);
        _topMostItem.Checked = value;
        Services.Log("setAlwaysOnTop", new { value, topMost = _widget.TopMost });
        BroadcastState();
    }

    public void SetAutoStart(bool value)
    {
        try
        {
            AutoStart.Set(value);
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            Toast("Could not change start-up setting", ex.Message, null);
        }
        _autoStartItem.Checked = SafeAutoStartEnabled();
        Services.Log("setAutoStart", new { value, enabled = _autoStartItem.Checked });
        BroadcastState();
    }

    public void SetHideFromCapture(bool value)
    {
        Settings.HideFromScreenCapture = value;
        Settings.Save();
        _widget.ApplyCaptureExclusion(value);
        _captureItem.Checked = value;
        BroadcastState();
    }

    public void SetStayOnDesktop(bool value)
    {
        Settings.StayOnDesktop = value;
        Settings.Save();
        _widget.ApplyStayOnDesktop(value);
        _desktopItem.Checked = value;
        BroadcastState();
    }

    public void SetMode(WidgetMode mode)
    {
        _widget.SetMode(mode);
        _expandedItem.Checked = mode == WidgetMode.Expanded;
        Services.Log("setMode", new { mode = mode.ToString(), _widget.Width, _widget.Height });
        BroadcastState();
    }

    /// <summary>Windows notification (balloon tips appear as toasts in Windows 10/11 Action Center).</summary>
    public void Toast(string title, string body, string? taskId)
    {
        // Burst protection: collapse floods (e.g. replay after a long offline period).
        if ((DateTime.UtcNow - _lastToastAt).TotalMilliseconds < 1500) return;
        _lastToastAt = DateTime.UtcNow;
        _lastToastTaskId = HostMessages.IsTaskId(taskId) ? taskId : null;
        _tray.ShowBalloonTip(6000, Trim(title, 63), Trim(string.IsNullOrWhiteSpace(body) ? "Open TaskSync to see details." : body, 255), ToolTipIcon.None);
        Services.Log("notify", new { title, taskId = _lastToastTaskId });
    }

    private static string Trim(string s, int max) => s.Length <= max ? s : s[..(max - 1)] + "…";

    private void BroadcastState()
    {
        var json = State.ToMessageJson();
        _widget.PostMessage(json);
        _dashboard?.PostMessage(json);
    }

    public void Exit()
    {
        Exiting = true;
        Settings.Save();
        _tray.Visible = false;
        _dashboard?.Close();
        _widget.Close();
        ExitThread();
    }

    // ---- Bridge ------------------------------------------------------------------

    public void Handle(WebWindow source, BridgeMessage msg)
    {
        switch (msg.Type)
        {
            case "getState":
                source.PostMessage(State.ToMessageJson());
                break;
            case "notify":
                Toast(msg.GetString("title", 200) ?? "TaskSync", msg.GetString("body", 500) ?? string.Empty, msg.GetString("taskId", 64));
                break;
            case "copyImage":
                var ok = msg.GetString("data", BridgeMessage.MaxMessageBytes) is { } data && Services.CopyPng(data);
                if (!ok) Services.Log("copyImageRejected");
                break;
            case "openExternal":
                if (msg.GetString("url") is { } url && !Services.OpenTeams(url)) Services.Log("openExternalRejected", new { url });
                break;
            case "openDashboard":
                OpenDashboard(msg.GetString("path", 300) ?? "/");
                break;
            case "setMode":
                SetMode(msg.GetString("mode", 20) == "expanded" ? WidgetMode.Expanded : WidgetMode.Compact);
                break;
            case "setAlwaysOnTop":
                if (msg.GetBool("value") is { } top) SetAlwaysOnTop(top);
                break;
            case "setAutoStart":
                if (msg.GetBool("value") is { } auto) SetAutoStart(auto);
                break;
            case "startDrag":
                if (source == _widget) _widget.BeginDrag();
                break;
            case "setHideFromCapture":
                if (msg.GetBool("value") is { } hide) SetHideFromCapture(hide);
                break;
            case "setStayOnDesktop":
                if (msg.GetBool("value") is { } stay) SetStayOnDesktop(stay);
                break;
            case "minimizeToTray":
                if (source == _widget) _widget.HideToTray();
                Services.Log("minimizeToTray");
                break;
            case "setBadge":
                var count = Math.Max(0, msg.GetInt("count") ?? 0);
                _tray.Text = count == 0 ? "TaskSync — all caught up" : $"TaskSync — {count} open task{(count == 1 ? "" : "s")}";
                break;
        }
    }

    private void OnPowerModeChanged(object? sender, PowerModeChangedEventArgs e)
    {
        // After sleep the realtime socket is usually dead: ask the page to reconnect at once.
        if (e.Mode != PowerModes.Resume) return;
        _widget.BeginInvoke(() =>
        {
            _widget.PostMessage(HostMessages.Resume());
            _dashboard?.PostMessage(HostMessages.Resume());
        });
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            SystemEvents.PowerModeChanged -= OnPowerModeChanged;
            _tray.Dispose();
        }
        base.Dispose(disposing);
    }
}
