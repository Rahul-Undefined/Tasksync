using System.Drawing;
using System.Drawing.Imaging;
using Microsoft.Win32;
using Xunit;

namespace TaskSync.Desktop.Tests;

public class AppSettingsTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "tasksync-tests-" + Guid.NewGuid().ToString("N"));
    private string FilePath => Path.Combine(_dir, "settings.json");

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    [Fact]
    public void RoundTripsWidgetSizePositionModeAndPin()
    {
        var s = AppSettings.Load(FilePath);
        s.Mode = WidgetMode.Expanded;
        s.AlwaysOnTop = false;
        s.SetBounds(WidgetMode.Compact, new Rectangle(10, 20, 380, 560));
        s.SetBounds(WidgetMode.Expanded, new Rectangle(30, 40, 460, 780));
        s.Save();

        var again = AppSettings.Load(FilePath);
        Assert.Equal(WidgetMode.Expanded, again.Mode);
        Assert.False(again.AlwaysOnTop);
        Assert.Equal(new Rectangle(10, 20, 380, 560), again.BoundsFor(WidgetMode.Compact));
        Assert.Equal(new Rectangle(30, 40, 460, 780), again.BoundsFor(WidgetMode.Expanded));
    }

    [Fact]
    public void PrivacyAndDesktopBehaviourDefaultToOnAndPersist()
    {
        var s = AppSettings.Load(FilePath);
        Assert.True(s.HideFromScreenCapture);
        Assert.True(s.StayOnDesktop);
        s.HideFromScreenCapture = false;
        s.Save();
        Assert.False(AppSettings.Load(FilePath).HideFromScreenCapture);
        Assert.True(AppSettings.Load(FilePath).StayOnDesktop);
    }

    [Fact]
    public void CorruptFileFallsBackToDefaults()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllText(FilePath, "{ not json");
        var s = AppSettings.Load(FilePath);
        Assert.Equal(AppSettings.DefaultBaseUrl, s.BaseUrl);
        Assert.Equal(WidgetMode.Compact, s.Mode);
    }

    [Theory]
    [InlineData("https://tasksync-vgam.onrender.com", true)]
    [InlineData("http://localhost:3000", true)]
    [InlineData("http://127.0.0.1:3000", true)]
    [InlineData("http://tasksync.example.com", false)]
    [InlineData("https://user:pass@tasksync.example.com", false)]
    [InlineData("javascript:alert(1)", false)]
    [InlineData("file:///C:/Windows", false)]
    [InlineData("", false)]
    public void OnlyHttpsOrLocalhostBaseUrlsAreAccepted(string url, bool allowed) =>
        Assert.Equal(allowed, AppSettings.IsAllowedBaseUrl(url));

    [Fact]
    public void UnsafeBaseUrlInSettingsFileIsReplaced()
    {
        Directory.CreateDirectory(_dir);
        File.WriteAllText(FilePath, """{ "BaseUrl": "http://evil.example.com" }""");
        Assert.Equal(AppSettings.DefaultBaseUrl, AppSettings.Load(FilePath).BaseUrl);
    }

    [Fact]
    public void OffScreenWindowIsMovedBackOnScreen()
    {
        var screens = new List<Rectangle> { new(0, 0, 1920, 1040) };
        // saved on a monitor that is no longer connected
        var r = AppSettings.NormalizeBounds(new Rectangle(3000, 200, 380, 560), new Size(380, 560), screens);
        Assert.True(screens[0].Contains(r), $"{r} should be inside the primary screen");
        // visible position is kept
        var kept = AppSettings.NormalizeBounds(new Rectangle(100, 100, 400, 600), new Size(380, 560), screens);
        Assert.Equal(new Rectangle(100, 100, 400, 600), kept);
        // absurd sizes are clamped
        var clamped = AppSettings.NormalizeBounds(new Rectangle(0, 0, 10, 10), new Size(380, 560), screens);
        Assert.True(clamped.Width >= AppSettings.MinimumSize.Width && clamped.Height >= AppSettings.MinimumSize.Height);
    }
}

public class AutoStartTests : IDisposable
{
    // A throwaway key: the real Run key is never touched by tests.
    private readonly string _key = @"Software\TaskSyncTests\Run-" + Guid.NewGuid().ToString("N");

    public void Dispose() => Registry.CurrentUser.DeleteSubKeyTree(_key.Substring(0, _key.LastIndexOf('\\')), throwOnMissingSubKey: false);

    [Fact]
    public void EnableAndDisableStartWithWindows()
    {
        var auto = new AutoStart(_key, @"C:\Program Files\TaskSync\TaskSync.exe");
        Assert.False(auto.IsEnabled);
        auto.Set(true);
        Assert.True(auto.IsEnabled);
        using (var k = Registry.CurrentUser.OpenSubKey(_key)!)
        {
            Assert.Equal("\"C:\\Program Files\\TaskSync\\TaskSync.exe\" --minimized", k.GetValue(AutoStart.ValueName));
        }
        auto.Set(false);
        Assert.False(auto.IsEnabled);
        auto.Set(false); // idempotent
    }
}

public class UrlPolicyTests
{
    private readonly UrlPolicy _policy = new("https://tasksync-vgam.onrender.com");

    [Theory]
    [InlineData("https://tasksync-vgam.onrender.com/widget", true)]
    [InlineData("https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?x=1", true)]
    [InlineData("https://aadcdn.msftauth.net/shared/1.0/content/js/x.js", true)]
    [InlineData("about:blank", true)]
    [InlineData("https://tasksync-vgam.onrender.com.evil.com/", false)]
    [InlineData("http://tasksync-vgam.onrender.com/", false)]
    [InlineData("https://evil.example.com/", false)]
    [InlineData("https://login.microsoftonline.com.evil.com/", false)]
    [InlineData("file:///C:/secret.txt", false)]
    public void NavigationAllowlist(string url, bool allowed) => Assert.Equal(allowed, _policy.IsAllowedNavigation(url));

    [Theory]
    [InlineData("https://teams.microsoft.com/l/chat/0/0?users=a@myomnifi.com&message=hi", true)]
    [InlineData("msteams:/l/chat/0/0?users=a@myomnifi.com", true)]
    [InlineData("https://teams.microsoft.com/evil", false)]
    [InlineData("https://teams.microsoft.com.evil.com/l/chat/0/0", false)]
    [InlineData("http://teams.microsoft.com/l/chat/0/0", false)]
    [InlineData("calc.exe", false)]
    [InlineData("file:///C:/Windows/System32/calc.exe", false)]
    [InlineData("ms-settings:privacy", false)]
    public void OnlyTeamsDeepLinksMayBeLaunched(string url, bool allowed) => Assert.Equal(allowed, UrlPolicy.IsAllowedExternal(url));

    [Fact]
    public void TeamsProtocolLinkFallsBackToHttps() =>
        Assert.Equal("https://teams.microsoft.com/l/chat/0/0?users=a@x.com", UrlPolicy.ToHttpsTeamsLink("msteams:/l/chat/0/0?users=a@x.com"));

    [Fact]
    public void AppOriginMatchesSchemeHostAndPort()
    {
        Assert.True(_policy.IsAppOrigin("https://tasksync-vgam.onrender.com/api/x"));
        Assert.False(_policy.IsAppOrigin("https://tasksync-vgam.onrender.com:8443/"));
        Assert.False(_policy.IsAppOrigin("http://tasksync-vgam.onrender.com/"));
        Assert.False(_policy.IsAppOrigin("data:text/html,hi"));
    }
}

public class BridgeTests
{
    [Fact]
    public void ParsesKnownMessages()
    {
        Assert.True(BridgeMessage.TryParse("""{"type":"setAlwaysOnTop","value":true}""", out var m));
        Assert.Equal("setAlwaysOnTop", m!.Type);
        Assert.True(m.GetBool("value"));
        Assert.True(BridgeMessage.TryParse("""{"type":"notify","title":"Hi","body":"There","taskId":null}""", out var n));
        Assert.Equal("Hi", n!.GetString("title"));
        Assert.Null(n.GetString("taskId"));
    }

    [Theory]
    [InlineData("""{"type":"runCommand","cmd":"calc"}""")]
    [InlineData("""{"kind":"notify"}""")]
    [InlineData("""["notify"]""")]
    [InlineData("""not json""")]
    [InlineData("")]
    public void RejectsUnknownOrMalformedMessages(string json) => Assert.False(BridgeMessage.TryParse(json, out _));

    [Fact]
    public void TruncatesLongStringsAndIgnoresWrongTypes()
    {
        Assert.True(BridgeMessage.TryParse($$"""{"type":"notify","title":"{{new string('x', 5000)}}","value":"yes"}""", out var m));
        Assert.Equal(200, m!.GetString("title", 200)!.Length);
        Assert.Null(m.GetBool("value"));
        Assert.Null(m.GetInt("title"));
    }

    [Fact]
    public void HostStateSerialisesForTheWebUi()
    {
        var json = new HostState("1.2.3", true, false, "compact", true, false).ToMessageJson();
        Assert.Equal("""{"type":"hostState","state":{"version":"1.2.3","alwaysOnTop":true,"autoStart":false,"mode":"compact","hideFromCapture":true,"stayOnDesktop":false}}""", json);
        Assert.True(HostMessages.IsTaskId(Guid.NewGuid().ToString()));
        Assert.False(HostMessages.IsTaskId("../../etc"));
    }
}

public class ClipboardTests
{
    private static void RunSta(Action action)
    {
        Exception? error = null;
        var t = new Thread(() =>
        {
            try { action(); }
            catch (Exception ex) { error = ex; }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        if (error is not null) throw new Xunit.Sdk.XunitException(error.ToString());
    }

    [Fact]
    public void CopiesPngToWindowsClipboardAndRejectsNonPng()
    {
        RunSta(() =>
        {
            // Preserve whatever text the developer had on the clipboard.
            var previous = Clipboard.ContainsText() ? Clipboard.GetText() : null;
            try
            {
                using var bmp = new Bitmap(40, 30);
                using (var g = Graphics.FromImage(bmp)) g.Clear(Color.MediumPurple);
                using var ms = new MemoryStream();
                bmp.Save(ms, ImageFormat.Png);
                var services = new HostServices();
                Assert.True(services.CopyPng(Convert.ToBase64String(ms.ToArray())));
                Assert.True(Clipboard.ContainsImage());
                Assert.True(Clipboard.ContainsData("PNG"));
                using var img = Clipboard.GetImage()!;
                Assert.Equal(40, img.Width);

                Assert.False(services.CopyPng(Convert.ToBase64String("MZ not a png at all"u8.ToArray())));
                Assert.False(services.CopyPng("%%%not-base64%%%"));
            }
            finally
            {
                if (previous is not null) Clipboard.SetText(previous);
                else Clipboard.Clear();
            }
        });
    }
}
