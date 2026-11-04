using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json.Serialization;

namespace TaskSync.Desktop;

/// <summary>What the TaskSync server says about the newest Windows build (GET /api/desktop/latest).</summary>
public sealed record UpdateInfo(
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("url")] string Url,
    [property: JsonPropertyName("sha256")] string Sha256,
    [property: JsonPropertyName("size")] long Size);

/// <summary>
/// Self-update without admin rights. New builds are downloaded in the background into
/// %LOCALAPPDATA%\TaskSync\versions\&lt;version&gt;\ after their SHA-256 matches the published one;
/// the next start (or "Restart to update") runs the newest one. Nothing outside the user's
/// own profile is touched, and an update that fails any check is simply discarded.
/// </summary>
public sealed class Updater
{
    public const string ExeName = "TaskSync.exe";
    public const long MaxDownloadBytes = 300L * 1024 * 1024;

    private readonly string _root;
    private readonly HttpClient _http;

    public Updater(string? root = null, HttpClient? http = null)
    {
        _root = root ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TaskSync", "versions");
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        if (!_http.DefaultRequestHeaders.UserAgent.Any()) _http.DefaultRequestHeaders.UserAgent.ParseAdd("TaskSync-desktop");
    }

    public string Root => _root;

    public static bool TryParseVersion(string? s, out Version version)
    {
        version = new Version(0, 0, 0);
        if (string.IsNullOrWhiteSpace(s) || s.Count(c => c == '.') != 2) return false;
        if (!Version.TryParse(s, out var v) || v.Major < 0 || v.Minor < 0 || v.Build < 0) return false;
        version = v;
        return true;
    }

    public static bool IsNewer(string candidate, string current) =>
        TryParseVersion(candidate, out var c) && (!TryParseVersion(current, out var cur) || c > cur);

    /// <summary>Only GitHub release downloads over https are accepted (the hash is checked as well).</summary>
    public static bool IsAllowedDownload(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u)
        && u.Scheme == Uri.UriSchemeHttps
        && u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase)
        && u.AbsolutePath.Contains("/releases/download/", StringComparison.Ordinal)
        && u.AbsolutePath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase);

    /// <summary>The newest downloaded version that is newer than <paramref name="current"/>, with its exe path.</summary>
    public (string Version, string ExePath)? NewestStaged(string current)
    {
        if (!Directory.Exists(_root)) return null;
        (string Version, string ExePath)? best = null;
        foreach (var dir in Directory.EnumerateDirectories(_root))
        {
            var name = Path.GetFileName(dir);
            var exe = Path.Combine(dir, ExeName);
            if (!IsNewer(name, current) || !File.Exists(exe)) continue;
            if (best is null || IsNewer(name, best.Value.Version)) best = (name, exe);
        }
        return best;
    }

    /// <summary>Asks the server for the newest build; downloads and stages it if it is newer. Returns the staged version.</summary>
    public async Task<string?> CheckAsync(string baseUrl, string current, CancellationToken ct = default)
    {
        UpdateInfo? info;
        using (var res = await _http.GetAsync($"{baseUrl.TrimEnd('/')}/api/desktop/latest", ct).ConfigureAwait(false))
        {
            if (!res.IsSuccessStatusCode) return null; // 404 = nothing published yet
            info = await res.Content.ReadFromJsonAsync<UpdateInfo>(ct).ConfigureAwait(false);
        }
        if (info is null || !IsNewer(info.Version, current)) return null;
        if (NewestStaged(current) is { } staged && !IsNewer(info.Version, staged.Version)) return staged.Version;
        return await StageAsync(info, ct).ConfigureAwait(false) ? info.Version : null;
    }

    public async Task<bool> StageAsync(UpdateInfo info, CancellationToken ct = default)
    {
        if (!TryParseVersion(info.Version, out _) || !IsAllowedDownload(info.Url)) return false;
        if (info.Sha256 is not { Length: 64 } || !info.Sha256.All(Uri.IsHexDigit)) return false;
        if (info.Size > MaxDownloadBytes) return false;

        Directory.CreateDirectory(_root);
        var work = Path.Combine(_root, ".staging-" + Guid.NewGuid().ToString("N"));
        var zip = work + ".zip";
        try
        {
            using (var res = await _http.GetAsync(info.Url, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false))
            {
                // Redirects (github.com → GitHub's download CDN) must stay on https.
                if (!res.IsSuccessStatusCode || res.RequestMessage?.RequestUri?.Scheme != Uri.UriSchemeHttps) return false;
                await using var file = File.Create(zip);
                await using var body = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
                var buffer = new byte[81920];
                long total = 0;
                int read;
                while ((read = await body.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
                {
                    total += read;
                    if (total > MaxDownloadBytes) return false;
                    await file.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                }
            }

            string hash;
            await using (var file = File.OpenRead(zip))
            {
                hash = Convert.ToHexString(await SHA256.HashDataAsync(file, ct).ConfigureAwait(false));
            }
            if (!hash.Equals(info.Sha256, StringComparison.OrdinalIgnoreCase)) return false;

            ZipFile.ExtractToDirectory(zip, work); // throws for entries that would escape the folder
            if (!File.Exists(Path.Combine(work, ExeName))) return false;

            var target = Path.Combine(_root, info.Version);
            if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
            Directory.Move(work, target);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException or HttpRequestException or TaskCanceledException)
        {
            return false;
        }
        finally
        {
            TryDelete(zip);
            TryDeleteDir(work);
        }
    }

    /// <summary>Removes leftovers and versions older than the one running (best effort, never the running one).</summary>
    public void CleanUp(string current)
    {
        if (!Directory.Exists(_root)) return;
        foreach (var dir in Directory.EnumerateDirectories(_root))
        {
            var name = Path.GetFileName(dir);
            if (name.StartsWith(".staging-", StringComparison.Ordinal) || (TryParseVersion(name, out _) && IsNewer(current, name)))
                TryDeleteDir(dir);
        }
        foreach (var file in Directory.EnumerateFiles(_root, ".staging-*.zip")) TryDelete(file);
    }

    /// <summary>Starts <paramref name="exePath"/> with the same arguments, telling it to wait for this process to exit.</summary>
    public static bool Launch(string exePath, IEnumerable<string> args)
    {
        try
        {
            var psi = new ProcessStartInfo(exePath) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exePath)! };
            foreach (var a in args.Where(a => !a.Equals("--after-pid", StringComparison.OrdinalIgnoreCase))) psi.ArgumentList.Add(a);
            psi.ArgumentList.Add("--after-pid");
            psi.ArgumentList.Add(Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return Process.Start(psi) is not null;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            // e.g. blocked by an application-control policy: keep running the current version.
            return false;
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static void TryDeleteDir(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }
}
