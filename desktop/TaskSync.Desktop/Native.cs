using System.Runtime.InteropServices;
using System.Text;

namespace TaskSync.Desktop;

internal static class Native
{
    public const int WM_NCLBUTTONDOWN = 0xA1;
    public const int HTCAPTION = 0x2;
    public const int WM_SIZE = 0x0005;
    public const int WM_WINDOWPOSCHANGING = 0x0046;
    public const int WM_SYSCOMMAND = 0x0112;
    public const int SC_MINIMIZE = 0xF020;
    public const int SIZE_MINIMIZED = 1;
    public const int SW_SHOWNOACTIVATE = 4;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint SWP_HIDEWINDOW = 0x0080;
    public const int WS_MINIMIZEBOX = 0x00020000;
    public const int WS_MAXIMIZEBOX = 0x00010000;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public static readonly IntPtr HWND_TOPMOST = new(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new(-2);

    // SetWindowDisplayAffinity: WDA_EXCLUDEFROMCAPTURE needs Windows 10 2004+; WDA_MONITOR (black box) is the older fallback.
    public const uint WDA_NONE = 0x0;
    public const uint WDA_MONITOR = 0x1;
    public const uint WDA_EXCLUDEFROMCAPTURE = 0x11;

    public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    public const uint WINEVENT_OUTOFCONTEXT = 0x0000;

    private const int DWMWA_EXCLUDED_FROM_PEEK = 12;
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWA_BORDER_COLOR = 34;
    private const int DWMWCP_ROUND = 2;

    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPOS
    {
        public IntPtr hwnd;
        public IntPtr hwndInsertAfter;
        public int x;
        public int y;
        public int cx;
        public int cy;
        public uint flags;
    }

    public delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint affinity);

    [DllImport("user32.dll")]
    public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProc proc, uint processId, uint threadId, uint flags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UnhookWinEvent(IntPtr hook);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    public static string ClassName(IntPtr hwnd)
    {
        var sb = new StringBuilder(256);
        return GetClassName(hwnd, sb, sb.Capacity) > 0 ? sb.ToString() : string.Empty;
    }

    /// <summary>True for the shell windows that come to the front on Show Desktop (Win+D) and desktop clicks.</summary>
    public static bool IsDesktopWindow(IntPtr hwnd) => ClassName(hwnd) is "WorkerW" or "Progman";

    /// <summary>Windows 11 look: dark frame, rounded corners and a subtle violet border. No-ops on older Windows.</summary>
    public static void ApplyWindowStyle(IntPtr hwnd)
    {
        try
        {
            int dark = 1;
            DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
            int round = DWMWCP_ROUND;
            DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int));
            int border = 0x00A35C8B; // COLORREF 0x00BBGGRR
            DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ref border, sizeof(int));
        }
        catch (DllNotFoundException)
        {
        }
        catch (EntryPointNotFoundException)
        {
        }
    }

    /// <summary>Keeps the window solid (not a glass outline) while Aero Peek shows the desktop.</summary>
    public static void SetExcludedFromPeek(IntPtr hwnd, bool excluded)
    {
        try
        {
            int value = excluded ? 1 : 0;
            DwmSetWindowAttribute(hwnd, DWMWA_EXCLUDED_FROM_PEEK, ref value, sizeof(int));
        }
        catch (DllNotFoundException)
        {
        }
    }

    /// <summary>
    /// Hides the window from screen sharing, recordings and screenshots while it stays visible
    /// on the local monitor. Returns the affinity actually applied.
    /// </summary>
    public static uint SetCaptureExclusion(IntPtr hwnd, bool exclude)
    {
        if (!exclude)
        {
            SetWindowDisplayAffinity(hwnd, WDA_NONE);
            return WDA_NONE;
        }
        if (SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)) return WDA_EXCLUDEFROMCAPTURE;
        // Windows 10 before 2004: the window shows as a black box in captures instead.
        return SetWindowDisplayAffinity(hwnd, WDA_MONITOR) ? WDA_MONITOR : WDA_NONE;
    }

    /// <summary>Starts a native window drag, as if the user grabbed the title bar.</summary>
    public static void BeginDrag(IntPtr hwnd)
    {
        ReleaseCapture();
        SendMessage(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, IntPtr.Zero);
    }
}
