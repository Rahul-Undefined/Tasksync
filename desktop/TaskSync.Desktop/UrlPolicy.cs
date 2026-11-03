namespace TaskSync.Desktop;

/// <summary>Decides what the embedded browser may load and which links may leave the app.</summary>
public sealed class UrlPolicy
{
    private readonly Uri _base;

    // Hosts used by the Microsoft Entra ID sign-in pages (login UI, its static assets, SSO).
    private static readonly string[] SignInHostSuffixes =
    {
        "login.microsoftonline.com",
        "login.microsoft.com",
        "login.windows.net",
        "aadcdn.msftauth.net",
        "aadcdn.msauth.net",
        "msauth.net",
        "msftauth.net",
        "autologon.microsoftazuread-sso.com",
        "account.activedirectory.windowsazure.com",
        "mysignins.microsoft.com",
    };

    public UrlPolicy(string baseUrl)
    {
        _base = new Uri(baseUrl.TrimEnd('/') + "/");
    }

    public Uri BaseUri => _base;

    public bool IsAppOrigin(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u)
        && u.Scheme == _base.Scheme
        && string.Equals(u.Host, _base.Host, StringComparison.OrdinalIgnoreCase)
        && u.Port == _base.Port;

    /// <summary>Top-level navigations allowed inside the widget/dashboard windows.</summary>
    public bool IsAllowedNavigation(string? url)
    {
        if (string.IsNullOrEmpty(url)) return false;
        if (url.StartsWith("about:blank", StringComparison.OrdinalIgnoreCase)) return true;
        if (url.StartsWith("data:text/html", StringComparison.OrdinalIgnoreCase)) return true; // our offline page
        if (IsAppOrigin(url)) return true;
        return Uri.TryCreate(url, UriKind.Absolute, out var u)
               && u.Scheme == Uri.UriSchemeHttps
               && SignInHostSuffixes.Any(s => u.Host.Equals(s, StringComparison.OrdinalIgnoreCase) || u.Host.EndsWith("." + s, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Links the web app may ask the host to open outside the app (Teams chats only).</summary>
    public static bool IsAllowedExternal(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return false;
        if (u.Scheme == "msteams") return u.AbsolutePath.StartsWith("/l/", StringComparison.Ordinal);
        return u.Scheme == Uri.UriSchemeHttps
               && u.Host.Equals("teams.microsoft.com", StringComparison.OrdinalIgnoreCase)
               && u.AbsolutePath.StartsWith("/l/", StringComparison.Ordinal);
    }

    /// <summary>Links opened in the user's default browser instead (e.g. pop-ups to other sites).</summary>
    public static bool IsSafeToOpenInBrowser(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeMailto);

    /// <summary>Converts an msteams: deep link into the equivalent https link (fallback when Teams is not installed).</summary>
    public static string ToHttpsTeamsLink(string url) =>
        url.StartsWith("msteams:", StringComparison.OrdinalIgnoreCase)
            ? "https://teams.microsoft.com" + url["msteams:".Length..]
            : url;
}
