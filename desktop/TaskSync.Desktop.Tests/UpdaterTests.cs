using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;
using Xunit;

namespace TaskSync.Desktop.Tests;

public class UpdaterTests : IDisposable
{
    private const string Base = "https://tasksync.example.com";
    private const string Download = "https://github.com/acme/tasksync/releases/download/desktop-v0.3.0/TaskSync-win-x64.zip";
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tasksync-upd-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    /// <summary>Answers the TaskSync server's /api/desktop/latest and the GitHub download with canned responses.</summary>
    private sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public List<string> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add(request.RequestUri!.ToString());
            var res = respond(request);
            res.RequestMessage = request;
            return Task.FromResult(res);
        }
    }

    private static byte[] BuildZip(params string[] names)
    {
        using var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var name in names)
            {
                using var w = new StreamWriter(zip.CreateEntry(name).Open());
                w.Write("payload of " + name);
            }
        }
        return ms.ToArray();
    }

    private (Updater updater, FakeHandler handler) Make(byte[] zip, string? sha = null, string url = Download, string version = "0.3.0")
    {
        sha ??= Convert.ToHexString(SHA256.HashData(zip)).ToLowerInvariant();
        var handler = new FakeHandler(req =>
        {
            if (req.RequestUri!.AbsolutePath == "/api/desktop/latest")
            {
                var json = $$"""{"version":"{{version}}","url":"{{url}}","sha256":"{{sha}}","size":{{zip.Length}}}""";
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
            }
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(zip) };
        });
        return (new Updater(_root, new HttpClient(handler)), handler);
    }

    [Theory]
    [InlineData("0.2.0", "0.1.0", true)]
    [InlineData("0.10.0", "0.9.9", true)]
    [InlineData("0.1.0", "0.1.0", false)]
    [InlineData("0.0.9", "0.1.0", false)]
    [InlineData("1.0", "0.1.0", false)]
    [InlineData("garbage", "0.1.0", false)]
    public void ComparesVersionsNumerically(string candidate, string current, bool newer) =>
        Assert.Equal(newer, Updater.IsNewer(candidate, current));

    [Theory]
    [InlineData(Download, true)]
    [InlineData("http://github.com/acme/tasksync/releases/download/x/TaskSync-win-x64.zip", false)]
    [InlineData("https://evil.example/acme/tasksync/releases/download/x/TaskSync-win-x64.zip", false)]
    [InlineData("https://github.com.evil.example/a/b/releases/download/x/a.zip", false)]
    [InlineData("https://github.com/acme/tasksync/archive/main.zip", false)]
    public void OnlyDownloadsGitHubReleaseZipsOverHttps(string url, bool allowed) =>
        Assert.Equal(allowed, Updater.IsAllowedDownload(url));

    [Fact]
    public async Task DownloadsVerifiesAndStagesANewerVersion()
    {
        var (updater, handler) = Make(BuildZip("TaskSync.exe", "TaskSync.dll"));
        Assert.Equal("0.3.0", await updater.CheckAsync(Base, "0.2.0"));
        var staged = updater.NewestStaged("0.2.0");
        Assert.NotNull(staged);
        Assert.Equal("0.3.0", staged!.Value.Version);
        Assert.True(File.Exists(staged.Value.ExePath));
        Assert.Equal($"{Base}/api/desktop/latest", handler.Requests[0]);

        // Already downloaded: the next check does not download it again.
        Assert.Equal("0.3.0", await updater.CheckAsync(Base, "0.2.0"));
        Assert.Equal(3, handler.Requests.Count);
        // Running the newest version: nothing to do.
        Assert.Null(await updater.CheckAsync(Base, "0.3.0"));
        Assert.Null(updater.NewestStaged("0.3.0"));
    }

    [Fact]
    public async Task RejectsABuildWhoseChecksumDoesNotMatch()
    {
        var (updater, _) = Make(BuildZip("TaskSync.exe"), sha: new string('0', 64));
        Assert.Null(await updater.CheckAsync(Base, "0.2.0"));
        Assert.Null(updater.NewestStaged("0.2.0"));
        Assert.Empty(Directory.EnumerateFileSystemEntries(_root));
    }

    [Fact]
    public async Task RejectsDownloadsFromAnywhereButGitHubReleases()
    {
        var (updater, handler) = Make(BuildZip("TaskSync.exe"), url: "https://evil.example/releases/download/x/TaskSync-win-x64.zip");
        Assert.Null(await updater.CheckAsync(Base, "0.2.0"));
        Assert.Single(handler.Requests); // never contacted the other host
    }

    [Fact]
    public async Task RejectsArchivesWithoutTheAppOrWithPathsOutsideTheFolder()
    {
        var (missingExe, _) = Make(BuildZip("readme.txt"));
        Assert.Null(await missingExe.CheckAsync(Base, "0.2.0"));
        var (escaping, _) = Make(BuildZip("TaskSync.exe", "../../outside.txt"));
        Assert.Null(await escaping.CheckAsync(Base, "0.2.0"));
        Assert.False(File.Exists(Path.Combine(_root, "..", "outside.txt")));
        Assert.Null(escaping.NewestStaged("0.2.0"));
    }

    [Fact]
    public void CleanUpKeepsTheRunningAndNewerVersionsOnly()
    {
        foreach (var v in new[] { "0.1.0", "0.2.0", "0.3.0", ".staging-abc" })
        {
            Directory.CreateDirectory(Path.Combine(_root, v));
            File.WriteAllText(Path.Combine(_root, v, "TaskSync.exe"), "x");
        }
        new Updater(_root, new HttpClient()).CleanUp("0.2.0");
        var left = Directory.EnumerateDirectories(_root).Select(d => Path.GetFileName(d)!).Order().ToArray();
        Assert.Equal(["0.2.0", "0.3.0"], left);
    }

    [Fact]
    public void StartWithWindowsFollowsTheAppToItsNewFolder()
    {
        var key = @"Software\TaskSyncTests\Run-" + Guid.NewGuid().ToString("N");
        try
        {
            new AutoStart(key, @"C:\old\TaskSync.exe").Set(true);
            var moved = new AutoStart(key, @"C:\Users\x\AppData\Local\TaskSync\versions\0.3.0\TaskSync.exe");
            Assert.False(moved.IsEnabled);
            Assert.True(moved.RefreshPath());
            Assert.True(moved.IsEnabled);
            Assert.False(moved.RefreshPath()); // nothing more to do

            var off = @"Software\TaskSyncTests\Run-" + Guid.NewGuid().ToString("N");
            Assert.False(new AutoStart(off, @"C:\x\TaskSync.exe").RefreshPath()); // never turns it on by itself
            Registry.CurrentUser.DeleteSubKeyTree(off, throwOnMissingSubKey: false);
        }
        finally
        {
            Registry.CurrentUser.DeleteSubKeyTree(key, throwOnMissingSubKey: false);
        }
    }

    [Fact]
    public void HostStateTellsTheWidgetAnUpdateIsReady()
    {
        var json = new HostState("0.2.0", true, false, "compact", true, true, "0.3.0").ToMessageJson();
        Assert.Contains("\"updateReady\":\"0.3.0\"", json);
        Assert.True(BridgeMessage.TryParse("{\"type\":\"restartToUpdate\"}", out _));
    }
}
