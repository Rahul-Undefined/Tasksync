using System.Drawing;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TaskSync.Desktop;

public enum WidgetMode
{
    Compact,
    Expanded,
}

public sealed class WindowBounds
{
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }

    public Rectangle ToRectangle() => new(X, Y, Width, Height);

    public static WindowBounds From(Rectangle r) => new() { X = r.X, Y = r.Y, Width = r.Width, Height = r.Height };
}

/// <summary>Per-user settings stored in %LOCALAPPDATA%\TaskSync\settings.json (never in the repo or registry).</summary>
public sealed class AppSettings
{
    public const string DefaultBaseUrl = "https://tasksync-vgam.onrender.com";
    public static readonly Size CompactSize = new(380, 560);
    public static readonly Size ExpandedSize = new(460, 780);
    public static readonly Size MinimumSize = new(320, 360);

    public string BaseUrl { get; set; } = DefaultBaseUrl;
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public WidgetMode Mode { get; set; } = WidgetMode.Compact;
    public bool AlwaysOnTop { get; set; } = true;
    /// <summary>Hide the widget from screen sharing, recordings and screenshots (still visible locally).</summary>
    public bool HideFromScreenCapture { get; set; } = true;
    /// <summary>Keep the widget visible on Show Desktop (Win+D), Minimise all (Win+M) and desktop peek.</summary>
    public bool StayOnDesktop { get; set; } = true;
    public WindowBounds? CompactBounds { get; set; }
    public WindowBounds? ExpandedBounds { get; set; }
    public WindowBounds? DashboardBounds { get; set; }

    [JsonIgnore]
    public string? FilePath { get; private set; }

    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public static string DataDirectory =>
        Environment.GetEnvironmentVariable("TASKSYNC_DATA_DIR") is { Length: > 0 } custom
            ? custom
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TaskSync");

    public static AppSettings Load(string? path = null)
    {
        path ??= Path.Combine(DataDirectory, "settings.json");
        AppSettings settings;
        try
        {
            settings = File.Exists(path)
                ? JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(path), JsonOptions) ?? new AppSettings()
                : new AppSettings();
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            // A corrupt or unreadable file must never stop the app from starting.
            settings = new AppSettings();
        }
        settings.FilePath = path;
        if (!IsAllowedBaseUrl(settings.BaseUrl)) settings.BaseUrl = DefaultBaseUrl;
        settings.BaseUrl = settings.BaseUrl.TrimEnd('/');
        return settings;
    }

    public void Save()
    {
        if (FilePath is null) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(this, JsonOptions));
            File.Move(tmp, FilePath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Losing a window position is not worth crashing over.
        }
    }

    /// <summary>HTTPS anywhere, or plain HTTP only for local development.</summary>
    public static bool IsAllowedBaseUrl(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u)
        && (u.Scheme == Uri.UriSchemeHttps || (u.Scheme == Uri.UriSchemeHttp && (u.IsLoopback || u.Host == "localhost")))
        && string.IsNullOrEmpty(u.UserInfo);

    public Rectangle? BoundsFor(WidgetMode mode) => (mode == WidgetMode.Compact ? CompactBounds : ExpandedBounds)?.ToRectangle();

    public void SetBounds(WidgetMode mode, Rectangle r)
    {
        if (mode == WidgetMode.Compact) CompactBounds = WindowBounds.From(r);
        else ExpandedBounds = WindowBounds.From(r);
    }

    /// <summary>
    /// Returns bounds that are visible on one of the given screens (e.g. after a monitor was
    /// unplugged), clamped to a sensible size. Falls back to the bottom-right of the primary screen.
    /// </summary>
    public static Rectangle NormalizeBounds(Rectangle? saved, Size defaultSize, IReadOnlyList<Rectangle> workingAreas)
    {
        var primary = workingAreas.Count > 0 ? workingAreas[0] : new Rectangle(0, 0, 1920, 1040);
        if (saved is { } r && r.Width > 0 && r.Height > 0)
        {
            var width = Math.Clamp(r.Width, MinimumSize.Width, 1600);
            var height = Math.Clamp(r.Height, MinimumSize.Height, 1400);
            var candidate = new Rectangle(r.X, r.Y, width, height);
            foreach (var area in workingAreas)
            {
                var visible = Rectangle.Intersect(area, candidate);
                // Require a reasonable part of the window (incl. its top bar) to be on screen.
                if (visible.Width >= 120 && visible.Height >= 80 && candidate.Y >= area.Y - 10) return candidate;
            }
        }
        return new Rectangle(
            primary.Right - defaultSize.Width - 24,
            primary.Bottom - defaultSize.Height - 24,
            defaultSize.Width,
            defaultSize.Height);
    }
}
