using Microsoft.Win32;

namespace TaskSync.Desktop;

/// <summary>
/// "Start with Windows" via the per-user Run key (no admin rights, user can also toggle it in
/// Windows Settings → Apps → Startup). The key path is injectable so tests never touch the real one.
/// </summary>
public sealed class AutoStart
{
    public const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string ValueName = "TaskSync";

    private readonly string _keyPath;
    private readonly string _exePath;

    public AutoStart(string? keyPath = null, string? exePath = null)
    {
        _keyPath = keyPath ?? RunKeyPath;
        _exePath = exePath ?? Environment.ProcessPath ?? Application.ExecutablePath;
    }

    public string Command => $"\"{_exePath}\" --minimized";

    public bool IsEnabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(_keyPath, writable: false);
            return key?.GetValue(ValueName) is string value && value.Contains(_exePath, StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>"Start with Windows" is on, possibly for another copy (e.g. the version before an update).</summary>
    public bool IsRegistered
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(_keyPath, writable: false);
            return key?.GetValue(ValueName) is string value && value.Contains(Updater.ExeName, StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>After an update the exe lives in a new folder: point "Start with Windows" at it.</summary>
    public bool RefreshPath()
    {
        if (IsEnabled || !IsRegistered || !_exePath.EndsWith(Updater.ExeName, StringComparison.OrdinalIgnoreCase)) return false;
        Set(true);
        return true;
    }

    public void Set(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(_keyPath, writable: true);
        if (enabled) key.SetValue(ValueName, Command, RegistryValueKind.String);
        else if (key.GetValue(ValueName) is not null) key.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}
