using System.Drawing;
using System.Runtime.InteropServices;

namespace TaskSync.Desktop;

/// <summary>
/// The floating widget: captionless, resizable, optionally always on top, hidden from the
/// taskbar (it lives in the tray). Remembers its size and position per mode.
/// Optionally invisible to screen sharing, and stays put on Show Desktop / Win+M / peek.
/// </summary>
public sealed class WidgetForm : WebWindow
{
    private readonly System.Windows.Forms.Timer _saveTimer = new() { Interval = 600 };
    private bool _applyingBounds;
    private bool _hidingOnPurpose;
    private bool _raisedForDesktop;
    private IntPtr _foregroundHook;
    private Native.WinEventProc? _foregroundProc; // kept referenced so the GC does not collect the callback

    public WidgetForm(HostController host) : base(host, "/widget")
    {
        Text = string.Empty; // with ControlBox=false this removes the caption but keeps the resize border
        ControlBox = false;
        FormBorderStyle = FormBorderStyle.Sizable;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        MinimumSize = Scale(AppSettings.MinimumSize);
        TopMost = host.Settings.AlwaysOnTop;
        Bounds = TargetBounds(host.Settings.Mode);
        _saveTimer.Tick += (_, _) =>
        {
            _saveTimer.Stop();
            if (WindowState != FormWindowState.Normal || !Visible) return;
            Host.Settings.SetBounds(Host.Settings.Mode, Bounds);
            Host.Settings.Save();
        };
        AccessibleName = "TaskSync widget";
    }

    private Size Scale(Size s)
    {
        var factor = DeviceDpi / 96f;
        return new Size((int)(s.Width * factor), (int)(s.Height * factor));
    }

    private Rectangle TargetBounds(WidgetMode mode)
    {
        var areas = Screen.AllScreens.OrderByDescending(s => s.Primary).Select(s => s.WorkingArea).ToList();
        var size = Scale(mode == WidgetMode.Compact ? AppSettings.CompactSize : AppSettings.ExpandedSize);
        return AppSettings.NormalizeBounds(Host.Settings.BoundsFor(mode), size, areas);
    }

    public void SetMode(WidgetMode mode)
    {
        if (Host.Settings.Mode == mode) return;
        Host.Settings.SetBounds(Host.Settings.Mode, Bounds);
        Host.Settings.Mode = mode;
        _applyingBounds = true;
        var target = TargetBounds(mode);
        // Grow/shrink from the current top-left corner if the mode has no saved position yet.
        if (Host.Settings.BoundsFor(mode) is null) target.Location = Location;
        Bounds = AppSettings.NormalizeBounds(target, target.Size, Screen.AllScreens.Select(s => s.WorkingArea).ToList());
        _applyingBounds = false;
        Host.Settings.Save();
    }

    public void SetAlwaysOnTop(bool value)
    {
        TopMost = value;
        Host.Settings.AlwaysOnTop = value;
        Host.Settings.Save();
    }

    public void BeginDrag() => Native.BeginDrag(Handle);

    /// <summary>The only way the widget gets hidden: the user chose to (tray / minimise button).</summary>
    public void HideToTray()
    {
        _hidingOnPurpose = true;
        try
        {
            Hide();
        }
        finally
        {
            _hidingOnPurpose = false;
        }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            // A tool window without minimise/maximise boxes is not part of "minimise all"
            // and does not appear in Alt+Tab (the widget lives in the tray).
            cp.ExStyle |= Native.WS_EX_TOOLWINDOW;
            cp.Style &= ~(Native.WS_MINIMIZEBOX | Native.WS_MAXIMIZEBOX);
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ApplyCaptureExclusion(Host.Settings.HideFromScreenCapture);
        ApplyStayOnDesktop(Host.Settings.StayOnDesktop);
    }

    public uint ApplyCaptureExclusion(bool hide)
    {
        var applied = Native.SetCaptureExclusion(Handle, hide);
        Host.Services.Log("captureExclusion", new { hide, affinity = applied, hwnd = Handle.ToInt64(), Bounds.X, Bounds.Y, Bounds.Width, Bounds.Height });
        return applied;
    }

    public void ApplyStayOnDesktop(bool stay)
    {
        Native.SetExcludedFromPeek(Handle, stay);
        if (stay && _foregroundHook == IntPtr.Zero)
        {
            _foregroundProc = OnForegroundChanged;
            _foregroundHook = Native.SetWinEventHook(
                Native.EVENT_SYSTEM_FOREGROUND, Native.EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, _foregroundProc, 0, 0, Native.WINEVENT_OUTOFCONTEXT);
        }
        else if (!stay && _foregroundHook != IntPtr.Zero)
        {
            Native.UnhookWinEvent(_foregroundHook);
            _foregroundHook = IntPtr.Zero;
        }
        Host.Services.Log("stayOnDesktop", new { stay, hwnd = Handle.ToInt64() });
    }

    /// <summary>
    /// Show Desktop (Win+D) brings the desktop window to the front. Lift the widget above it
    /// (without stealing focus) and drop back to normal z-order once another app is active.
    /// </summary>
    private void OnForegroundChanged(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (!Visible || IsDisposed || !Host.Settings.StayOnDesktop) return;
        if (Native.IsDesktopWindow(hwnd))
        {
            Native.SetWindowPos(Handle, Native.HWND_TOPMOST, 0, 0, 0, 0,
                Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
            _raisedForDesktop = !TopMost;
            Host.Services.Log("desktopShown");
        }
        else if (_raisedForDesktop && hwnd != Handle)
        {
            Native.SetWindowPos(Handle, Native.HWND_NOTOPMOST, 0, 0, 0, 0, Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
            _raisedForDesktop = false;
        }
    }

    protected override void WndProc(ref Message m)
    {
        var guard = Host.Settings.StayOnDesktop && !Host.Exiting && !_hidingOnPurpose;
        if (guard && m.Msg == Native.WM_SYSCOMMAND && ((int)m.WParam & 0xFFF0) == Native.SC_MINIMIZE)
        {
            Host.Services.Log("minimizeBlocked", new { source = "syscommand" });
            return; // ignore minimise requests from the system or other apps
        }
        if (guard && m.Msg == Native.WM_WINDOWPOSCHANGING && Visible)
        {
            var pos = Marshal.PtrToStructure<Native.WINDOWPOS>(m.LParam);
            if ((pos.flags & Native.SWP_HIDEWINDOW) != 0)
            {
                pos.flags &= ~Native.SWP_HIDEWINDOW;
                Marshal.StructureToPtr(pos, m.LParam, false);
                Host.Services.Log("minimizeBlocked", new { source = "hide" });
            }
        }
        base.WndProc(ref m);
        if (guard && m.Msg == Native.WM_SIZE && (int)m.WParam == Native.SIZE_MINIMIZED)
        {
            // Something minimised us anyway (e.g. Win+M): restore without taking focus.
            BeginInvoke(() =>
            {
                Native.ShowWindow(Handle, Native.SW_SHOWNOACTIVATE);
                Host.Services.Log("minimizeBlocked", new { source = "restored" });
            });
        }
    }

    protected override void OnMove(EventArgs e)
    {
        base.OnMove(e);
        QueueSave();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        QueueSave();
    }

    private void QueueSave()
    {
        if (_applyingBounds || !IsHandleCreated) return;
        _saveTimer.Stop();
        _saveTimer.Start();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // Closing the widget (Alt+F4) minimises it to the tray; Exit is in the tray menu.
        if (e.CloseReason == CloseReason.UserClosing && !Host.Exiting)
        {
            e.Cancel = true;
            HideToTray();
            return;
        }
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _saveTimer.Dispose();
        if (_foregroundHook != IntPtr.Zero) Native.UnhookWinEvent(_foregroundHook);
        _foregroundHook = IntPtr.Zero;
        base.Dispose(disposing);
    }
}

/// <summary>The full dashboard in a normal resizable window (shares the widget's sign-in).</summary>
public sealed class DashboardForm : WebWindow
{
    public DashboardForm(HostController host, string path) : base(host, path)
    {
        Text = "TaskSync";
        StartPosition = FormStartPosition.Manual;
        MinimumSize = new Size(420, 520);
        var areas = Screen.AllScreens.OrderByDescending(s => s.Primary).Select(s => s.WorkingArea).ToList();
        var primary = areas[0];
        var size = new Size(Math.Min(1280, primary.Width - 80), Math.Min(860, primary.Height - 80));
        var fallback = new Rectangle(primary.X + (primary.Width - size.Width) / 2, primary.Y + (primary.Height - size.Height) / 2, size.Width, size.Height);
        Bounds = AppSettings.NormalizeBounds(host.Settings.DashboardBounds?.ToRectangle() ?? fallback, size, areas);
        ResizeEnd += (_, _) => SaveBounds();
        AccessibleName = "TaskSync dashboard";
    }

    private void SaveBounds()
    {
        if (WindowState != FormWindowState.Normal) return;
        Host.Settings.DashboardBounds = WindowBounds.From(Bounds);
        Host.Settings.Save();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        SaveBounds();
        base.OnFormClosing(e);
    }
}
