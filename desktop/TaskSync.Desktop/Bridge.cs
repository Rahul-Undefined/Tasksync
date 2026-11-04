using System.Text.Json;
using System.Text.Json.Serialization;

namespace TaskSync.Desktop;

/// <summary>A validated message from the web UI (window.chrome.webview.postMessage).</summary>
public sealed record BridgeMessage(string Type, JsonElement Payload)
{
    public const int MaxMessageBytes = 12 * 1024 * 1024; // allows a large PNG for the clipboard

    private static readonly HashSet<string> KnownTypes = new(StringComparer.Ordinal)
    {
        "notify", "copyImage", "openExternal", "openDashboard", "setMode", "setAlwaysOnTop",
        "setAutoStart", "startDrag", "minimizeToTray", "getState", "setBadge",
        "setHideFromCapture", "setStayOnDesktop", "restartToUpdate",
    };

    public static bool TryParse(string? json, out BridgeMessage? message)
    {
        message = null;
        if (string.IsNullOrEmpty(json) || json.Length > MaxMessageBytes) return false;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;
            if (!doc.RootElement.TryGetProperty("type", out var t) || t.ValueKind != JsonValueKind.String) return false;
            var type = t.GetString()!;
            if (!KnownTypes.Contains(type)) return false;
            message = new BridgeMessage(type, doc.RootElement.Clone());
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    public string? GetString(string name, int maxLength = 2000)
    {
        if (!Payload.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.String) return null;
        var s = v.GetString();
        return s is null ? null : s.Length > maxLength ? s[..maxLength] : s;
    }

    public bool? GetBool(string name) =>
        Payload.TryGetProperty(name, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False)
            ? v.GetBoolean()
            : null;

    public int? GetInt(string name) =>
        Payload.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;
}

/// <summary>State the host reports back to the web UI.</summary>
public sealed record HostState(
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("alwaysOnTop")] bool AlwaysOnTop,
    [property: JsonPropertyName("autoStart")] bool AutoStart,
    [property: JsonPropertyName("mode")] string Mode,
    [property: JsonPropertyName("hideFromCapture")] bool HideFromCapture = true,
    [property: JsonPropertyName("stayOnDesktop")] bool StayOnDesktop = true,
    [property: JsonPropertyName("updateReady")] string? UpdateReady = null)
{
    public string ToMessageJson() =>
        JsonSerializer.Serialize(new { type = "hostState", state = this });
}

public static class HostMessages
{
    public static string OpenTask(string taskId) => JsonSerializer.Serialize(new { type = "openTask", taskId });
    public static string Navigate(string path) => JsonSerializer.Serialize(new { type = "navigate", path });
    public static string Resume() => JsonSerializer.Serialize(new { type = "resume" });
    public static string OpenSheet(string sheet) => JsonSerializer.Serialize(new { type = "openSheet", sheet });

    public static bool IsTaskId(string? id) => Guid.TryParse(id, out _) && id!.Length == 36;
}
