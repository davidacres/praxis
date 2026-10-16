using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Praxis.CodeIntelligence.Indexing;

/// <summary>Explicit project execution boundary. Never called by registration, indexing, MCP or a watcher.</summary>
public static class ContextCapture
{
    public static async Task<string> CaptureAsync(string root, string projectPath, string outputPath = "context.praxis.json",
        string configuration = "Debug", string? framework = null, bool restore = false, CancellationToken cancellationToken = default,
        ICollection<string>? skippedExternalSources = null)
    {
        root = SourceFiles.CanonicalDirectory(root);
        var destination = SourceFiles.Resolve(root, outputPath);
        if (!outputPath.EndsWith(".praxis.json", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Capture output must end in .praxis.json.");
        foreach (var value in new[] { configuration, framework }.OfType<string>())
            if (!Regex.IsMatch(value, "^[A-Za-z0-9_. -]{1,128}$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50))) throw new ArgumentException("Invalid configuration/framework.");
        var executable = Environment.GetEnvironmentVariable("PRAXIS_DOTNET") ?? "dotnet";
        var projects = new Dictionary<string, PassiveProject>(StringComparer.Ordinal); var visiting = new HashSet<string>(StringComparer.Ordinal);
        var capturedRequests = new Dictionary<string, string>(StringComparer.Ordinal);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); timeout.CancelAfter(TimeSpan.FromMinutes(2));
        await CaptureProject(projectPath, framework);
        var manifest = JsonSerializer.Serialize(new PassiveManifest(1, projects.Values.OrderBy(project => project.Key, StringComparer.Ordinal).ToArray()),
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true });
        if (Encoding.UTF8.GetByteCount(manifest) > SourceFiles.MaximumBytes) throw new IOException("INPUT_TOO_LARGE: capture manifest exceeds its limit.");
        var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        try { await File.WriteAllTextAsync(temporary, manifest + "\n", new UTF8Encoding(false), timeout.Token); File.Move(temporary, destination, overwrite: true); }
        finally { File.Delete(temporary); }
        return outputPath;

        async Task<string> CaptureProject(string relativePath, string? target)
        {
            var full = SourceFiles.Resolve(root, relativePath);
            if (!full.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Capture requires a C# project.");
            var key = relativePath + "#" + configuration + "#" + (target ?? "default");
            if (capturedRequests.TryGetValue(key, out var capturedKey)) return capturedKey;
            if (!visiting.Add(key)) throw new ArgumentException("Project reference cycle is unsupported.");
            if (projects.Count + visiting.Count > 200) throw new IOException("INPUT_TOO_LARGE: project capture limit exceeded.");
            var args = new List<string> { "msbuild", full, "-nologo", "-m:1", "-p:BuildProjectReferences=false", "-p:Configuration=" + configuration };
            if (target is not null) args.Add("-p:TargetFramework=" + target);
            if (restore) args.Add("-restore");
            args.Add("-target:ResolveReferences");
            args.Add("-getItem:Compile,ReferencePath,ProjectReference");
            args.Add("-getProperty:AssemblyName,DefineConstants,LangVersion,AllowUnsafeBlocks,TargetFramework,TargetFrameworks,OutputType,Nullable,MSBuildAllProjects");
            var result = await Run(executable, root, args, timeout.Token);
            var properties = result["Properties"]!.AsObject(); var items = result["Items"]!.AsObject();
            string Property(string name) => properties[name]?.GetValue<string>() ?? "";
            if (Property("TargetFrameworks").Length > 0 && Property("TargetFramework").Length == 0) throw new ArgumentException("Choose --framework for a multi-target project.");
            var slot = relativePath + "#" + configuration + "#" + Property("TargetFramework");
            var allSources = new List<string>(); var support = new List<string>();
            foreach (var item in items["Compile"]?.AsArray() ?? [])
            {
                var path = ItemPath(item!, full);
                // Packages can inject compile items from outside the repository
                // (Microsoft.NET.Test.Sdk adds a generated test entry point). The
                // manifest never references files outside the root, so they are
                // reported and left out rather than failing the whole capture.
                if (!Within(root, path)) { skippedExternalSources?.Add(path); continue; }
                var relative = Relative(root, path); SourceFiles.Resolve(root, relative);
                if (relative.Split('/').Any(part => part is "obj" or "bin") || relative.EndsWith(".g.cs", StringComparison.OrdinalIgnoreCase)) support.Add(relative); else allSources.Add(relative);
            }
            var references = new List<string>(); var referencedDirectories = new HashSet<string>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
            foreach (var item in items["ProjectReference"]?.AsArray() ?? [])
            {
                if (item?["ReferenceOutputAssembly"]?.GetValue<string>().Equals("false", StringComparison.OrdinalIgnoreCase) == true) continue;
                var path = ItemPath(item!, full); var relative = Relative(root, path);
                var nearest = item?["NearestTargetFramework"]?.GetValue<string>();
                references.Add(await CaptureProject(relative, string.IsNullOrWhiteSpace(nearest) ? null : nearest));
                referencedDirectories.Add(Path.GetDirectoryName(path)!);
            }
            var metadata = new List<MetadataInput>();
            foreach (var item in items["ReferencePath"]?.AsArray() ?? [])
            {
                if (item?["ReferenceSourceTarget"]?.GetValue<string>() == "ProjectReference" || item?["MSBuildSourceProjectFile"] is not null) continue;
                var path = ItemPath(item!, full);
                if (referencedDirectories.Any(directory => path.StartsWith(directory + Path.DirectorySeparatorChar, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))) continue;
                var bytes = PassiveManifest.ReadExternal(path);
                var aliases = item?["Aliases"]?.GetValue<string>().Split([',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                var embed = item?["EmbedInteropTypes"]?.GetValue<string>().Equals("true", StringComparison.OrdinalIgnoreCase) == true;
                metadata.Add(new(path, SourceFiles.Hash(bytes), aliases, embed));
            }
            var inputs = new List<ProjectInput>();
            foreach (var path in Property("MSBuildAllProjects").Split(';', StringSplitOptions.RemoveEmptyEntries).Append(full).Distinct(StringComparer.Ordinal))
            {
                var absolute = Path.GetFullPath(path, Path.GetDirectoryName(full)!);
                var bytes = PassiveManifest.ReadExternal(absolute); var relative = Path.GetRelativePath(root, absolute);
                inputs.Add(new(relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) || Path.IsPathRooted(relative) ? absolute : relative.Replace('\\', '/'), SourceFiles.Hash(bytes)));
            }
            projects[slot] = new(slot, Property("AssemblyName"), allSources.Distinct(StringComparer.Ordinal).ToArray(), references.ToArray(), metadata.ToArray(), inputs.ToArray(),
                Property("DefineConstants").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
                string.IsNullOrWhiteSpace(Property("LangVersion")) ? "default" : Property("LangVersion"),
                Property("AllowUnsafeBlocks").Equals("true", StringComparison.OrdinalIgnoreCase), support.Distinct(StringComparer.Ordinal).ToArray(),
                string.IsNullOrWhiteSpace(Property("Nullable")) ? "disable" : Property("Nullable"), string.IsNullOrWhiteSpace(Property("OutputType")) ? "library" : Property("OutputType"));
            capturedRequests[key] = slot; visiting.Remove(key); return slot;
        }
    }

    private static bool Within(string root, string path)
    {
        var relative = Path.GetRelativePath(root, path);
        return relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) && !Path.IsPathRooted(relative);
    }
    private static string Relative(string root, string path)
    {
        var relative = Path.GetRelativePath(root, path).Replace('\\', '/'); SourceFiles.Resolve(root, relative); return relative;
    }
    private static string ItemPath(JsonNode item, string project) => Path.GetFullPath(item["FullPath"]?.GetValue<string>() ?? item["Identity"]!.GetValue<string>(), Path.GetDirectoryName(project)!);
    private static async Task<JsonObject> Run(string executable, string root, IEnumerable<string> arguments, CancellationToken cancellationToken)
    {
        var start = new ProcessStartInfo(executable) { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start) ?? throw new IOException("Cannot start the explicitly requested project capture.");
        try
        {
            var output = ReadBounded(process.StandardOutput, 2 * 1024 * 1024, cancellationToken);
            var errors = ReadBounded(process.StandardError, 128 * 1024, cancellationToken);
            await process.WaitForExitAsync(cancellationToken); var text = await output; var errorText = await errors;
            if (process.ExitCode != 0)
            {
                // MSBuild reports most failures on stdout; surface a bounded few.
                var reasons = (text + "\n" + errorText).Split('\n').Select(line => line.Trim())
                    .Where(line => Regex.IsMatch(line, @"\berror [A-Z]+[0-9]+:", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50)))
                    .Distinct(StringComparer.Ordinal).Take(3).Select(line => line.Length > 400 ? line[..400] + "…" : line).ToArray();
                throw new IOException("Project context capture failed. " + (reasons.Length > 0 ? string.Join(" | ", reasons)
                    : "Check SDK/references and explicitly choose --restore if needed."));
            }
            var first = text.IndexOf('{'); var last = text.LastIndexOf('}');
            if (first < 0 || last < first) throw new IOException("Project capture returned no bounded JSON metadata.");
            return JsonNode.Parse(text[first..(last + 1)])!.AsObject();
        }
        catch { try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } throw; }
    }
    private static async Task<string> ReadBounded(StreamReader reader, int maximum, CancellationToken cancellationToken)
    {
        var result = new StringBuilder(); var chunk = new char[4096]; int count;
        while ((count = await reader.ReadAsync(chunk, cancellationToken)) > 0)
        { if (result.Length + count > maximum) throw new IOException("Project capture output exceeds its limit."); result.Append(chunk, 0, count); }
        return result.ToString();
    }
}
