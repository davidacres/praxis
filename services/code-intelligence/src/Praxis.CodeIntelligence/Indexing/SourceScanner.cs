namespace Praxis.CodeIntelligence.Indexing;

public static class SourceScanner
{
    private static readonly HashSet<string> ExcludedDirectories = new(StringComparer.OrdinalIgnoreCase)
    { ".git", "bin", "obj", "node_modules", "vendor", "dist", "coverage", ".idea", ".vs" };

    public static IReadOnlyList<SourceInput> Scan(string root, IReadOnlyList<string> excludedPrefixes, CancellationToken cancellationToken)
    {
        root = SourceFiles.CanonicalDirectory(root);
        var sources = new List<SourceInput>(); var directories = new Stack<string>(); directories.Push(root);
        long bytes = 0; var entries = 0;
        while (directories.TryPop(out var directory))
        {
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory).Order(StringComparer.Ordinal))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (++entries > 200_000) throw new IOException("INPUT_TOO_LARGE: repository entry limit exceeded.");
                var relative = System.IO.Path.GetRelativePath(root, entry).Replace('\\', '/');
                if (IsExcluded(relative, excludedPrefixes)) continue;
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    if (!ExcludedDirectories.Contains(System.IO.Path.GetFileName(entry))) directories.Push(entry);
                    continue;
                }
                if (!entry.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) || entry.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase)) continue;
                var source = SourceFiles.Read(root, relative, cancellationToken); sources.Add(source); bytes += source.Bytes.Length;
                if (sources.Count > 25_000 || bytes > 256L * 1024 * 1024) throw new IOException("INPUT_TOO_LARGE: repository source limit exceeded.");
            }
        }
        return sources.OrderBy(s => s.Path, StringComparer.Ordinal).ToArray();
    }

    public static bool IsExcluded(string relativePath, IReadOnlyList<string> prefixes) => prefixes.Any(prefix =>
        relativePath.Equals(prefix.TrimEnd('/'), StringComparison.OrdinalIgnoreCase)
        || relativePath.StartsWith(prefix.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase));
}
