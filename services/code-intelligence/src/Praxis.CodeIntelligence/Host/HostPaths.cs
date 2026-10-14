namespace Praxis.CodeIntelligence.Host;

public static class HostPaths
{
    public static string DefaultDataDirectory()
    {
        if (OperatingSystem.IsWindows()) return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Praxis", "code-intelligence");
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (OperatingSystem.IsMacOS()) return Path.Combine(home, "Library", "Application Support", "Praxis", "code-intelligence");
        var xdg = Environment.GetEnvironmentVariable("XDG_DATA_HOME");
        return Path.Combine(xdg is not null && Path.IsPathRooted(xdg) ? xdg : Path.Combine(home, ".local", "share"), "Praxis", "code-intelligence");
    }
}
