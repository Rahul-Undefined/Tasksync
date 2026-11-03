using System.Drawing;
using System.Net.NetworkInformation;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace TaskSync.Desktop;

/// <summary>
/// A window hosting the TaskSync web UI in WebView2. Handles navigation policy, the
/// JS ↔ host bridge, and graceful recovery when the server is unreachable (offline,
/// Render cold start, network change).
/// </summary>
public abstract class WebWindow : Form
{
    private static Task<CoreWebView2Environment>? _environment;

    protected readonly HostController Host;
    protected readonly WebView2 Web;
    private string _startPath;
    private readonly System.Windows.Forms.Timer _retryTimer = new();
    private int _failures;
    private bool _showingOffline;

    protected WebWindow(HostController host, string startPath)
    {
        Host = host;
        _startPath = startPath;
        BackColor = Color.FromArgb(7, 9, 20);
        Icon = HostController.AppIcon;
        Web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(7, 9, 20) };
        Controls.Add(Web);
        _retryTimer.Tick += (_, _) =>
        {
            _retryTimer.Stop();
            NavigateToApp();
        };
        NetworkChange.NetworkAvailabilityChanged += OnNetworkChanged;
    }

    /// <summary>All windows share one browser profile so the Microsoft sign-in persists across windows and restarts.</summary>
    private static Task<CoreWebView2Environment> SharedEnvironment() =>
        _environment ??= CoreWebView2Environment.CreateAsync(
            browserExecutableFolder: null,
            userDataFolder: Path.Combine(AppSettings.DataDirectory, "WebView2"));

    protected override async void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.ApplyWindowStyle(Handle);
        try
        {
            await Web.EnsureCoreWebView2Async(await SharedEnvironment());
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(
                "TaskSync needs the Microsoft Edge WebView2 Runtime, which is included with Windows 11. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and start TaskSync again.",
                "TaskSync", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Application.Exit();
            return;
        }
        ConfigureWebView(Web.CoreWebView2);
        NavigateToApp();
    }

    private void ConfigureWebView(CoreWebView2 core)
    {
        var s = core.Settings;
        s.AreDevToolsEnabled = Host.Services.TestMode || System.Diagnostics.Debugger.IsAttached;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;
        s.AreDefaultContextMenusEnabled = true; // copy/paste in text boxes
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;

        core.NavigationStarting += (_, e) =>
        {
            if (Host.Policy.IsAllowedNavigation(e.Uri)) return;
            e.Cancel = true;
            Host.Services.OpenInBrowser(e.Uri);
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (Host.Policy.IsAppOrigin(e.Uri)) Host.OpenDashboard(new Uri(e.Uri).PathAndQuery);
            else if (UrlPolicy.IsAllowedExternal(e.Uri)) Host.Services.OpenTeams(e.Uri);
            else Host.Services.OpenInBrowser(e.Uri);
        };
        core.NavigationCompleted += (_, e) =>
        {
            if (e.IsSuccess)
            {
                if (Host.Policy.IsAppOrigin(core.Source)) _failures = 0;
                return;
            }
            if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
            ShowOffline(e.WebErrorStatus.ToString());
        };
        core.PermissionRequested += (_, e) =>
        {
            // Notifications and the clipboard go through the host bridge; the page gets no
            // camera, microphone, location, clipboard-read or notification permissions.
            e.State = CoreWebView2PermissionState.Deny;
        };
        core.WebMessageReceived += (_, e) =>
        {
            // Only the TaskSync origin may talk to the host.
            if (!Host.Policy.IsAppOrigin(e.Source)) return;
            if (BridgeMessage.TryParse(e.WebMessageAsJson, out var msg) && msg is not null) Host.Handle(this, msg);
        };
    }

    protected void NavigateToApp()
    {
        if (Web.CoreWebView2 is null) return;
        _showingOffline = false;
        Web.CoreWebView2.Navigate(new Uri(Host.Policy.BaseUri, _startPath.TrimStart('/')).ToString());
    }

    public void NavigateTo(string path)
    {
        _startPath = path.StartsWith('/') ? path : "/";
        NavigateToApp();
    }

    public void PostMessage(string json)
    {
        if (Web.CoreWebView2 is null || _showingOffline) return;
        if (!Host.Policy.IsAppOrigin(Web.CoreWebView2.Source)) return;
        Web.CoreWebView2.PostWebMessageAsJson(json);
    }

    private void ShowOffline(string reason)
    {
        _failures++;
        var delay = Math.Min(30, (int)Math.Pow(2, Math.Min(_failures, 5)));
        _showingOffline = true;
        Host.Services.Log("offline", new { reason, retryInSeconds = delay });
        Web.CoreWebView2.NavigateToString(OfflinePage.Html(Host.Policy.BaseUri.ToString(), delay, reason));
        _retryTimer.Interval = delay * 1000;
        _retryTimer.Start();
    }

    private void OnNetworkChanged(object? sender, NetworkAvailabilityEventArgs e)
    {
        if (!e.IsAvailable || !_showingOffline || IsDisposed) return;
        BeginInvoke(() =>
        {
            _retryTimer.Stop();
            _failures = 0;
            NavigateToApp();
        });
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            NetworkChange.NetworkAvailabilityChanged -= OnNetworkChanged;
            _retryTimer.Dispose();
        }
        base.Dispose(disposing);
    }
}

internal static class OfflinePage
{
    public static string Html(string baseUrl, int retrySeconds, string reason) => $$"""
        <!doctype html><html><head><meta charset="utf-8"><title>TaskSync</title>
        <style>
          html,body{height:100%;margin:0;background:#070914;color:#eef1ff;font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
          body{display:grid;place-items:center;background:radial-gradient(600px 400px at 0% 0%,rgba(64,95,220,.35),transparent 60%),radial-gradient(500px 400px at 100% 100%,rgba(140,70,230,.32),transparent 60%),#070914}
          .card{width:min(320px,86vw);padding:28px 24px;border-radius:24px;text-align:center;background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.14);box-shadow:0 20px 50px -20px rgba(0,0,0,.7)}
          .mark{width:48px;height:48px;margin:0 auto 14px;border-radius:15px;background:linear-gradient(135deg,#5b8cff,#8b5cf6 55%,#c084fc);display:grid;place-items:center;font-size:26px}
          h1{font-size:18px;margin:0 0 6px} p{color:rgba(226,232,255,.7);font-size:13px;line-height:1.5;margin:0 0 16px}
          a{display:inline-block;padding:9px 16px;border-radius:11px;color:#fff;text-decoration:none;font-weight:600;background:linear-gradient(135deg,#5b8cff,#8b5cf6 55%,#c084fc)}
          small{display:block;margin-top:12px;color:rgba(226,232,255,.4);font-size:11px}
        </style></head><body><div class="card"><div class="mark">✓</div>
        <h1>Reconnecting to TaskSync…</h1>
        <p>You may be offline, or the server is waking up after a quiet period. Retrying automatically in <span id="s">{{retrySeconds}}</span>s.</p>
        <a href="{{System.Net.WebUtility.HtmlEncode(baseUrl)}}">Retry now</a><small>{{System.Net.WebUtility.HtmlEncode(reason)}}</small></div>
        <script>let s={{retrySeconds}};setInterval(()=>{if(s>0)document.getElementById('s').textContent=--s},1000)</script>
        </body></html>
        """;
}
