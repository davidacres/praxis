namespace Praxis.CodeIntelligence.Indexing;

public static class SourceScanner
{
    private static readonly HashSet<string> ExcludedDirectories = new(StringComparer.OrdinalIgnoreCase)
    { ".git", "bin", "obj", "node_modules", "vendor", "dist", "coverage", ".idea", ".vs" };

    public static IReadOnlyList<SourceInput> Scan(string root, IReadOnlyList<string> excludedPrefixes, CancellationToken cancellationToken)
    {
        root = SourceFiles.CanonicalDirectory(root);
        var sources = new List<SourceInput>(); var candidates = new List<string>(); var directories = new Stack<string>(); directories.Push(root);
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
                if (!IsSearchableSourceFile(entry)) continue;
                candidates.Add(relative);
                if (candidates.Count > 25_000) throw new IOException("INPUT_TOO_LARGE: repository source limit exceeded.");
            }
        }
        foreach (var path in GitFilePolicy.Filter(root, candidates, cancellationToken))
        {
            var source = SourceFiles.Read(root, path, cancellationToken); sources.Add(source); bytes += source.Bytes.Length;
            if (bytes > 256L * 1024 * 1024) throw new IOException("INPUT_TOO_LARGE: repository source limit exceeded.");
        }
        return sources.OrderBy(s => s.Path, StringComparer.Ordinal).ToArray();
    }

    public static bool IsSearchableSourceFile(string path)
    {
        if (path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
            return !path.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase);
        if (path.EndsWith(".d.ts", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".d.mts", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".d.cts", StringComparison.OrdinalIgnoreCase))
            return false;
        if (path.EndsWith(".ts", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".tsx", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".mts", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".cts", StringComparison.OrdinalIgnoreCase))
            return true;
        if (path.EndsWith(".min.js", StringComparison.OrdinalIgnoreCase))
            return false;
        return path.EndsWith(".js", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".jsx", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".mjs", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".cjs", StringComparison.OrdinalIgnoreCase);
    }

    public const long MaximumDocumentBytes = 25L * 1024 * 1024;
    public const long MaximumBinaryDocumentBytes = 25L * 1024 * 1024;

    public static bool IsSearchableDocumentFile(string path)
    {
        var fileName = System.IO.Path.GetFileName(path);
        if (fileName.Equals("package-lock.json", StringComparison.OrdinalIgnoreCase)
            || fileName.Equals("packages.lock.json", StringComparison.OrdinalIgnoreCase)
            || fileName.EndsWith(".lock.json", StringComparison.OrdinalIgnoreCase))
            return false;

        var ext = System.IO.Path.GetExtension(path);
        var matches = ext.Equals(".md", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".docx", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".pptx", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".csv", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".txt", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".json", StringComparison.OrdinalIgnoreCase);

        if (!matches) return false;

        if (System.IO.Path.IsPathRooted(path) && File.Exists(path))
        {
            var length = new FileInfo(path).Length;
            if (length > MaximumBinaryDocumentBytes) return false;
        }

        return true;
    }

    public static IReadOnlyList<string> ScanDocumentPaths(string root, IReadOnlyList<string> excludedPrefixes, CancellationToken cancellationToken)
    {
        root = SourceFiles.CanonicalDirectory(root);
        var candidates = new List<string>(); var directories = new Stack<string>(); directories.Push(root);
        var entries = 0;
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
                if (!IsSearchableDocumentFile(entry)) continue;
                candidates.Add(relative);
                if (candidates.Count > 25_000) throw new IOException("INPUT_TOO_LARGE: repository document limit exceeded.");
            }
        }
        return GitFilePolicy.Filter(root, candidates, cancellationToken).OrderBy(p => p, StringComparer.Ordinal).ToArray();
    }

    public static bool IsExcluded(string relativePath, IReadOnlyList<string> prefixes) => prefixes.Any(prefix =>
        relativePath.Equals(prefix.TrimEnd('/'), StringComparison.OrdinalIgnoreCase)
        || relativePath.StartsWith(prefix.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase));
}
