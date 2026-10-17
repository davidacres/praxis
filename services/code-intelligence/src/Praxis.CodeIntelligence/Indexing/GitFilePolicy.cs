using System.Diagnostics;
using System.Text;

namespace Praxis.CodeIntelligence.Indexing;

internal static class GitFilePolicy
{
    public static IReadOnlyList<string> Filter(string root, IReadOnlyList<string> paths, CancellationToken cancellationToken)
    {
        if (!InsideGitWorkTree(root)) return paths;
        var ignored = new HashSet<string>(StringComparer.Ordinal);
        foreach (var batch in paths.Chunk(2000))
        {
            var input = string.Join('\0', batch) + "\0";
            if (Encoding.UTF8.GetByteCount(input) > 4 * 1024 * 1024) throw new IOException("INPUT_TOO_LARGE: ignore policy input exceeds its limit.");
            var start = new ProcessStartInfo(ResolveGit(root))
            {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = new UTF8Encoding(false)
            };
            foreach (var argument in new[] { "-c", "core.fsmonitor=false", "--no-optional-locks", "check-ignore", "--no-index", "-z", "--stdin" }) start.ArgumentList.Add(argument);
            using var process = Process.Start(start) ?? throw new IOException("Cannot evaluate Git ignore policy.");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); deadline.CancelAfter(TimeSpan.FromSeconds(5));
            try
            {
                var output = ReadBounded(process.StandardOutput, 4 * 1024 * 1024, deadline.Token);
                var errors = ReadBounded(process.StandardError, 64 * 1024, deadline.Token);
                process.StandardInput.WriteAsync(input.AsMemory(), deadline.Token).GetAwaiter().GetResult(); process.StandardInput.Close();
                process.WaitForExitAsync(deadline.Token).GetAwaiter().GetResult();
                var result = output.GetAwaiter().GetResult(); _ = errors.GetAwaiter().GetResult();
                if (process.ExitCode is not (0 or 1)) throw new IOException("Git ignore policy could not be evaluated.");
                foreach (var path in result.Split('\0', StringSplitOptions.RemoveEmptyEntries)) ignored.Add(path);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            { try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } throw new IOException("Git ignore policy timed out."); }
            catch { try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } throw; }
        }
        return paths.Where(path => !ignored.Contains(path)).ToArray();
    }
    // A registered root is often a folder inside a repository (apps/web), so look for
    // .git in the root and every ancestor; check-ignore resolves paths against its cwd.
    private static bool InsideGitWorkTree(string root)
    {
        for (var directory = new DirectoryInfo(root); directory is not null; directory = directory.Parent)
        {
            var marker = Path.Combine(directory.FullName, ".git");
            if (Directory.Exists(marker) || File.Exists(marker)) return true;
        }
        return false;
    }
    private static async Task<string> ReadBounded(StreamReader reader, int maximum, CancellationToken cancellationToken)
    {
        var buffer = new char[4096]; var result = new StringBuilder(); int count;
        while ((count = await reader.ReadAsync(buffer, cancellationToken)) > 0)
        {
            if (result.Length + count > maximum) throw new IOException("Git ignore output exceeds its limit.");
            result.Append(buffer, 0, count);
        }
        return result.ToString();
    }
    private static string ResolveGit(string root)
    {
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            if (!Path.IsPathRooted(directory)) continue; // Never resolve a program relative to an untrusted repository cwd.
            try
            {
                var physicalDirectory = SourceFiles.CanonicalDirectory(directory);
                var candidate = Path.Combine(physicalDirectory, OperatingSystem.IsWindows() ? "git.exe" : "git");
                if (!File.Exists(candidate)) continue;
                candidate = new FileInfo(candidate).ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? candidate;
                if (candidate.StartsWith(root + Path.DirectorySeparatorChar, comparison)) continue;
                if (!OperatingSystem.IsWindows() && (File.GetUnixFileMode(candidate) & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute)) == 0) continue;
                return candidate;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
        throw new IOException("A trusted Git executable outside the indexed root is required to honor Git ignore policy.");
    }
}
