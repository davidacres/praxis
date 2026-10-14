using System.Text.Json;
using System.Text.Json.Serialization;

namespace Praxis.CodeIntelligence.Indexing;

public sealed record MetadataInput(string Path, string ContentHash);
public sealed record ProjectInput(string Path, string ContentHash);
public sealed record PassiveProject(string Key, string AssemblyName, string[] Sources, string[]? References = null,
    MetadataInput[]? Metadata = null, ProjectInput[]? Inputs = null, string[]? Defines = null, string LanguageVersion = "default", bool AllowUnsafe = false);
public sealed record PassiveManifest(int Version, PassiveProject[] Projects)
{
    public static PassiveManifest Read(string root, string relativePath)
    {
        var source = SourceFiles.Read(root, relativePath);
        var manifest = JsonSerializer.Deserialize<PassiveManifest>(source.Text, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
        }) ?? throw new ArgumentException("Passive manifest is empty.");
        if (manifest.Version != 1 || manifest.Projects is null || manifest.Projects.Length is < 1 or > 200
            || manifest.Projects.Any(p => string.IsNullOrWhiteSpace(p.Key) || string.IsNullOrWhiteSpace(p.AssemblyName) || p.Sources is null)
            || manifest.Projects.Select(p => p.Key).Distinct(StringComparer.Ordinal).Count() != manifest.Projects.Length)
            throw new ArgumentException("Passive manifest version or project keys are invalid.");
        foreach (var project in manifest.Projects)
        {
            foreach (var input in project.Inputs ?? [])
            {
                var bytes = System.IO.Path.IsPathRooted(input.Path) ? ReadExternal(input.Path) : SourceFiles.Read(root, input.Path).Bytes;
                if (SourceFiles.Hash(bytes) != input.ContentHash) throw new IOException("INDEX_STALE: captured project input changed.");
            }
        }
        return manifest;
    }

    internal static byte[] ReadExternal(string path)
    {
        using var stream = File.OpenRead(path);
        if (stream.Length > 128 * 1024 * 1024) throw new IOException("INPUT_TOO_LARGE: captured reference exceeds the limit.");
        using var buffer = new MemoryStream(); var chunk = new byte[64 * 1024]; int count;
        while ((count = stream.Read(chunk)) > 0)
        {
            if (buffer.Length + count > 128 * 1024 * 1024) throw new IOException("INPUT_TOO_LARGE: captured reference exceeds the limit.");
            buffer.Write(chunk, 0, count);
        }
        return buffer.ToArray();
    }
}
