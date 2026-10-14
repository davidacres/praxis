using System.Security.Cryptography;
using System.Text;

namespace Praxis.CodeIntelligence.Indexing;

public sealed record SourceInput(string Path, string Hash, byte[] Bytes, string Text);

/// <summary>Bounded source reads. Coordinates use decoded UTF-16; freshness uses raw bytes.</summary>
public static class SourceFiles
{
    public const int MaximumBytes = 2 * 1024 * 1024;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly UnicodeEncoding Utf16Le = new(false, false, true);
    private static readonly UnicodeEncoding Utf16Be = new(true, false, true);

    public static string Hash(ReadOnlySpan<byte> bytes) => "sha256:" + Convert.ToHexStringLower(SHA256.HashData(bytes));

    public static string CanonicalDirectory(string path)
    {
        var full = System.IO.Path.GetFullPath(path);
        var root = System.IO.Path.GetPathRoot(full)!;
        var current = root;
        foreach (var component in full[root.Length..].Split(System.IO.Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            var directory = new DirectoryInfo(System.IO.Path.Combine(current, component));
            if (!directory.Exists) throw new DirectoryNotFoundException("Repository root is unavailable.");
            current = directory.LinkTarget is null ? directory.FullName
                : directory.ResolveLinkTarget(returnFinalTarget: true)?.FullName
                  ?? throw new IOException("Repository root alias cannot be resolved.");
        }
        return System.IO.Path.TrimEndingDirectorySeparator(current);
    }

    public static string Resolve(string root, string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath) || System.IO.Path.IsPathRooted(relativePath)
            || relativePath.Contains('\\') || relativePath.Contains(':') || relativePath.Contains('\0'))
            throw new ArgumentException("Source path must be relative with forward slashes.", nameof(relativePath));
        var parts = relativePath.Split('/');
        if (parts.Any(x => x is "" or "." or "..")) throw new ArgumentException("Source path contains an invalid component.", nameof(relativePath));
        var current = CanonicalDirectory(root);
        for (var index = 0; index < parts.Length; index++)
        {
            current = System.IO.Path.Combine(current, parts[index]);
            FileSystemInfo info = index == parts.Length - 1 ? new FileInfo(current) : new DirectoryInfo(current);
            // Check attributes too: Windows reparse points need not expose LinkTarget.
            if (info.LinkTarget is not null || (info.Exists && (info.Attributes & FileAttributes.ReparsePoint) != 0))
                throw new IOException("Source symlinks and reparse points are excluded.");
        }
        return current;
    }

    public static SourceInput Read(string root, string relativePath, CancellationToken cancellationToken = default)
    {
        var path = Resolve(root, relativePath);
        using var stream = SafeSourceHandle.Read(root, relativePath, path);
        if (stream.Length > MaximumBytes) throw new IOException("INPUT_TOO_LARGE: source exceeds the byte limit.");
        using var buffer = new MemoryStream();
        var chunk = new byte[16 * 1024];
        int count;
        while ((count = stream.Read(chunk)) != 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (buffer.Length + count > MaximumBytes) throw new IOException("INPUT_TOO_LARGE: source exceeds the byte limit.");
            buffer.Write(chunk, 0, count);
        }
        // Re-check path policy after reading; a detected path swap never returns source.
        if (Resolve(root, relativePath) != path) throw new IOException("Source path changed during reading.");
        var bytes = buffer.ToArray();
        return new(relativePath, Hash(bytes), bytes, Decode(bytes));
    }

    public static string Decode(ReadOnlySpan<byte> bytes)
    {
        if (bytes.StartsWith(new byte[] { 0xff, 0xfe, 0x00, 0x00 }) || bytes.StartsWith(new byte[] { 0x00, 0x00, 0xfe, 0xff }))
            throw new DecoderFallbackException("UNSUPPORTED_ENCODING: UTF-32 is unsupported.");
        if (bytes.StartsWith(new byte[] { 0xef, 0xbb, 0xbf })) return Utf8.GetString(bytes[3..]);
        if (bytes.StartsWith(new byte[] { 0xff, 0xfe })) return Utf16Le.GetString(bytes[2..]);
        if (bytes.StartsWith(new byte[] { 0xfe, 0xff })) return Utf16Be.GetString(bytes[2..]);
        return Utf8.GetString(bytes);
    }
}
