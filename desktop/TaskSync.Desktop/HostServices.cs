using System.Diagnostics;
using System.Drawing;
using System.Text.Json;

namespace TaskSync.Desktop;

/// <summary>
/// Side effects the web UI can request. When TASKSYNC_TEST_LOG is set (automated tests),
/// actions are also written there and external apps are not launched.
/// </summary>
public sealed class HostServices
{
    private readonly string? _testLog = Environment.GetEnvironmentVariable("TASKSYNC_TEST_LOG");

    public bool TestMode => !string.IsNullOrEmpty(_testLog);

    public void Log(string action, object? data = null)
    {
        if (_testLog is null) return;
        try
        {
            var line = JsonSerializer.Serialize(new { at = DateTimeOffset.UtcNow, action, data });
            File.AppendAllText(_testLog, line + Environment.NewLine);
        }
        catch (IOException)
        {
        }
    }

    /// <summary>Puts a PNG on the Windows clipboard in both PNG and bitmap formats (Teams accepts either).</summary>
    public bool CopyPng(string base64)
    {
        if (string.IsNullOrEmpty(base64) || base64.Length > BridgeMessage.MaxMessageBytes) return false;
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            return false;
        }
        // PNG signature check: never put arbitrary data on the clipboard.
        if (bytes.Length < 8 || bytes[0] != 0x89 || bytes[1] != 0x50 || bytes[2] != 0x4E || bytes[3] != 0x47) return false;
        using var ms = new MemoryStream(bytes);
        using var image = Image.FromStream(ms);
        var data = new DataObject();
        data.SetData("PNG", false, new MemoryStream(bytes));
        data.SetImage(new Bitmap(image));
        Clipboard.SetDataObject(data, copy: true, retryTimes: 5, retryDelay: 100);
        Log("copyImage", new { bytes = bytes.Length, image.Width, image.Height });
        return true;
    }

    /// <summary>Opens an allowed Teams deep link: the Teams app if installed, otherwise the browser.</summary>
    public bool OpenTeams(string url)
    {
        if (!UrlPolicy.IsAllowedExternal(url)) return false;
        Log("openExternal", new { url });
        if (TestMode) return true;
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            // msteams: protocol not registered (Teams not installed): use Teams on the web.
            Process.Start(new ProcessStartInfo(UrlPolicy.ToHttpsTeamsLink(url)) { UseShellExecute = true });
        }
        return true;
    }

    public void OpenInBrowser(string url)
    {
        if (!UrlPolicy.IsSafeToOpenInBrowser(url)) return;
        Log("openBrowser", new { url });
        if (TestMode) return;
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}
