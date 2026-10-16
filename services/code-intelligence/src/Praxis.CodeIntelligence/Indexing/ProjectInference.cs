using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace Praxis.CodeIntelligence.Indexing;

public sealed record InferredContext(PassiveManifest? Manifest, IReadOnlyList<string> SupportSources, IReadOnlyList<IndexedDiagnostic> Diagnostics);

/// <summary>
/// Execution-free project context for SDK-style C# projects. Reads project XML,
/// Directory.Build.props, restore output (obj/project.assets.json) and installed
/// reference packs; never runs MSBuild, targets, restore or generators. Anything
/// MSBuild would compute dynamically is invisible here, so the result is a best
/// effort that the compiler reports as complete or partial; an explicitly
/// captured manifest remains the high-fidelity path.
/// </summary>
public static class ProjectInference
{
    private const int MaximumProjects = 200;
    private static readonly HashSet<string> SkippedDirectories = new(StringComparer.OrdinalIgnoreCase)
    { ".git", "bin", "obj", "node_modules", "vendor", "dist", "coverage", ".idea", ".vs" };
    private static readonly string[] CommonUsings =
        ["System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net.Http", "System.Threading", "System.Threading.Tasks"];
    private static readonly string[] WebUsings =
        ["System.Net.Http.Json", "Microsoft.AspNetCore.Builder", "Microsoft.AspNetCore.Hosting", "Microsoft.AspNetCore.Http", "Microsoft.AspNetCore.Routing",
         "Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging"];
    private static readonly string[] WorkerUsings =
        ["Microsoft.Extensions.Configuration", "Microsoft.Extensions.DependencyInjection", "Microsoft.Extensions.Hosting", "Microsoft.Extensions.Logging"];
    // Reference assemblies rarely change; hashing them on every reconciliation pass would
    // re-read tens of megabytes. Entries are keyed by path, length and write time.
    private static readonly ConcurrentDictionary<string, (long Length, DateTime Written, string Hash)> Hashes = new(StringComparer.Ordinal);
    // Injectable for tests: dotnet installation roots searched for reference packs.
    internal static Func<IEnumerable<string>> DotnetRoots { get; set; } = DefaultDotnetRoots;

    public static InferredContext? Infer(string root, IReadOnlyList<SourceInput> sources, IReadOnlyList<string> excludes, CancellationToken cancellationToken)
    {
        root = SourceFiles.CanonicalDirectory(root);
        var projectPaths = FindProjects(root, excludes, cancellationToken);
        if (projectPaths.Count == 0) return null;
        var sourcePaths = sources.Where(source => source.Role == "searchableSource").Select(source => source.Path).ToArray();
        var keyByPath = projectPaths.ToDictionary(path => path, path => path[..^".csproj".Length], StringComparer.Ordinal);
        var projectDirectories = projectPaths.Select(path => DirectoryOf(path)).ToArray();
        var diagnostics = new List<IndexedDiagnostic>(); var support = new List<string>();
        var directOnly = new HashSet<string>(StringComparer.Ordinal); // DisableTransitiveProjectReferences=true
        var projects = new List<PassiveProject>();
        foreach (var path in projectPaths)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try { projects.Add(Project(path)); }
            catch (Exception ex) when (ex is IOException or XmlException or JsonException or ArgumentException or UnauthorizedAccessException)
            { diagnostics.Add(Diagnostic("PROJECT_INFERENCE_FAILED", "warning", $"{path}: project context could not be inferred ({ex.GetType().Name}); its files are indexed syntax-only.")); }
        }
        if (projects.Count == 0) return new(null, [], diagnostics); // nothing usable; keep the reasons
        // Drop references that would form a cycle or point at projects that failed.
        var keys = projects.Select(project => project.Key).ToHashSet(StringComparer.Ordinal);
        projects = projects.Select(project => project with { References = (project.References ?? []).Where(keys.Contains).ToArray() }).ToList();
        projects = BreakCycles(projects);
        // The SDK flows project references transitively unless a project opts out, so a
        // test project sees types from the projects its references depend on.
        var direct = projects.ToDictionary(project => project.Key, project => project.References ?? [], StringComparer.Ordinal);
        projects = projects.Select(project => directOnly.Contains(project.Key) ? project : project with { References = Closure(project.Key) }).ToList();
        return new(new PassiveManifest(1, projects.OrderBy(project => project.Key, StringComparer.Ordinal).ToArray()), support.Distinct(StringComparer.Ordinal).ToArray(), diagnostics);

        PassiveProject Project(string path)
        {
            var directory = DirectoryOf(path);
            var properties = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Configuration"] = "Debug", ["MSBuildProjectName"] = Path.GetFileNameWithoutExtension(path) };
            var inputs = new List<ProjectInput>();
            foreach (var props in DirectoryBuildProps(directory))
            {
                ReadProperties(Load(props), properties);
                inputs.Add(new(props, SourceFiles.Read(root, props, cancellationToken).Hash));
            }
            var document = Load(path); var sdk = (document.Root?.Attribute("Sdk")?.Value ?? "Microsoft.NET.Sdk").Trim();
            ReadProperties(document, properties);
            inputs.Add(new(path, SourceFiles.Read(root, path, cancellationToken).Hash));
            var framework = Value("TargetFramework") is { Length: > 0 } single ? single
                : Value("TargetFrameworks").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).OrderByDescending(FrameworkRank).FirstOrDefault() ?? "";
            properties["TargetFramework"] = framework;
            var assemblyName = Value("AssemblyName") is { Length: > 0 } named ? named : Path.GetFileNameWithoutExtension(path);
            if (Value("DisableTransitiveProjectReferences").Equals("true", StringComparison.OrdinalIgnoreCase)) directOnly.Add(keyByPath[path]);

            // Compile items: SDK default glob unless disabled, then explicit Include/Remove.
            var members = new HashSet<string>(StringComparer.Ordinal);
            var defaults = !Value("EnableDefaultItems").Equals("false", StringComparison.OrdinalIgnoreCase)
                && !Value("EnableDefaultCompileItems").Equals("false", StringComparison.OrdinalIgnoreCase);
            if (defaults)
                foreach (var source in sourcePaths)
                    if (Under(source, directory) && !NestedProjectOwns(source, directory)) members.Add(source);
            foreach (var item in Items(document, "Compile"))
            {
                if (item.Attribute("Include")?.Value is { } include)
                    foreach (var match in Glob(directory, include)) members.Add(match);
                if (item.Attribute("Remove")?.Value is { } remove)
                    foreach (var match in Glob(directory, remove)) members.Remove(match);
            }

            var references = new List<string>();
            foreach (var item in Items(document, "ProjectReference"))
                if (item.Attribute("Include")?.Value is { } include && Normalize(Combine(directory, include)) is { } target && keyByPath.TryGetValue(target, out var key))
                    references.Add(key);

            var metadata = new List<MetadataInput>(); var assets = Combine(directory, "obj/project.assets.json");
            var frameworkReferences = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Microsoft.NETCore.App" };
            if (sdk.StartsWith("Microsoft.NET.Sdk.Web", StringComparison.OrdinalIgnoreCase) || sdk.StartsWith("Microsoft.NET.Sdk.Razor", StringComparison.OrdinalIgnoreCase))
                frameworkReferences.Add("Microsoft.AspNetCore.App");
            foreach (var item in Items(document, "FrameworkReference"))
                if (item.Attribute("Include")?.Value is { Length: > 0 } name) frameworkReferences.Add(name);
            if (File.Exists(Path.Combine(root, assets)))
            {
                inputs.Add(new(assets, Hash(Path.Combine(root, assets)) ?? throw new IOException("Restore output is unreadable.")));
                metadata.AddRange(PackageReferences(Path.Combine(root, assets), framework, frameworkReferences));
            }
            else if (Items(document, "PackageReference").Any())
                diagnostics.Add(Diagnostic("PACKAGES_NOT_RESTORED", "info", $"{path}: package references are unresolved until the project has been restored or built once."));
            var frameworkAssemblies = FrameworkReferences(framework, frameworkReferences).ToArray();
            if (frameworkAssemblies.Length == 0)
                diagnostics.Add(Diagnostic("FRAMEWORK_REFERENCES_UNAVAILABLE", "info", $"{path}: no installed reference pack for {framework}; using this service's runtime assemblies."));
            metadata.InsertRange(0, frameworkAssemblies.Length > 0 ? frameworkAssemblies : RuntimeAssemblies());
            metadata = metadata.DistinctBy(input => input.Path, StringComparer.Ordinal).DistinctBy(input => Path.GetFileName(input.Path), StringComparer.OrdinalIgnoreCase).ToList();

            // Implicit usings: prefer the SDK's own generated file; otherwise synthesize the
            // SDK defaults plus explicit <Using> items.
            string[]? implicitUsings = null;
            if (Value("ImplicitUsings") is "enable" or "true" or "True" or "Enable")
            {
                var generated = Directory.Exists(Path.Combine(root, directory, "obj"))
                    ? Directory.EnumerateFiles(Path.Combine(root, directory, "obj"), assemblyName + ".GlobalUsings.g.cs", SearchOption.AllDirectories)
                        .Select(file => Path.GetRelativePath(root, file).Replace('\\', '/'))
                        .Where(file => file.Contains("/" + framework + "/", StringComparison.OrdinalIgnoreCase) && !SourceScanner.IsExcluded(file, excludes))
                        .OrderBy(file => file.Contains("/Debug/", StringComparison.OrdinalIgnoreCase) ? 0 : 1).FirstOrDefault()
                    : null;
                if (generated is not null) { support.Add(generated); members.Add(generated); }
                else
                {
                    var usings = new List<string>(CommonUsings);
                    if (sdk.StartsWith("Microsoft.NET.Sdk.Web", StringComparison.OrdinalIgnoreCase)) usings.AddRange(WebUsings);
                    else if (sdk.StartsWith("Microsoft.NET.Sdk.Worker", StringComparison.OrdinalIgnoreCase)) usings.AddRange(WorkerUsings);
                    foreach (var item in Items(document, "Using"))
                    {
                        if (item.Attribute("Remove")?.Value is { } removed) usings.Remove(removed);
                        if (item.Attribute("Include")?.Value is not { Length: > 0 } include || !Regex.IsMatch(include, @"^[A-Za-z_][A-Za-z0-9_.]*$")) continue;
                        var alias = item.Attribute("Alias")?.Value; var isStatic = item.Attribute("Static")?.Value?.Equals("true", StringComparison.OrdinalIgnoreCase) == true;
                        usings.Add(alias is { Length: > 0 } && Regex.IsMatch(alias, @"^[A-Za-z_][A-Za-z0-9_]*$") ? $"{alias} = global::{include}" : isStatic ? $"static global::{include}" : include);
                    }
                    implicitUsings = usings.Distinct(StringComparer.Ordinal).Select(value => value.Contains('=') || value.StartsWith("static ", StringComparison.Ordinal) ? value : "global::" + value).ToArray();
                }
            }

            var defines = new List<string>();
            var defined = Value("DefineConstants");
            defines.AddRange((defined.Length > 0 ? defined : "DEBUG;TRACE").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Where(value => value != "$(DefineConstants)"));
            if (!defines.Contains("DEBUG") && properties["Configuration"] == "Debug") defines.Add("DEBUG");
            defines.AddRange(FrameworkDefines(framework));
            var language = Value("LangVersion") is { Length: > 0 } requested && Microsoft.CodeAnalysis.CSharp.LanguageVersionFacts.TryParse(requested, out _) ? requested : "default";
            var nullable = Value("Nullable").ToLowerInvariant() is "enable" or "warnings" or "annotations" or "disable" ? Value("Nullable").ToLowerInvariant() : "disable";
            var outputType = Value("OutputType").ToLowerInvariant() is "exe" ? "exe" : Value("OutputType").ToLowerInvariant() is "winexe" ? "winexe"
                : sdk.StartsWith("Microsoft.NET.Sdk.Web", StringComparison.OrdinalIgnoreCase) || sdk.StartsWith("Microsoft.NET.Sdk.Worker", StringComparison.OrdinalIgnoreCase) ? "exe" : "library";
            return new PassiveProject(keyByPath[path], assemblyName, members.Where(member => !support.Contains(member)).Order(StringComparer.Ordinal).ToArray(), references.Distinct(StringComparer.Ordinal).ToArray(),
                metadata.ToArray(), inputs.ToArray(), defines.Distinct(StringComparer.Ordinal).ToArray(), language,
                Value("AllowUnsafeBlocks").Equals("true", StringComparison.OrdinalIgnoreCase), support.Where(members.Contains).ToArray(), nullable, outputType, implicitUsings);

            string Value(string name) => properties.TryGetValue(name, out var value) ? value.Trim() : "";
            bool NestedProjectOwns(string source, string owner) => projectDirectories.Any(other => other.Length > owner.Length && Under(other + "/x", owner) && Under(source, other));
        }

        void ReadProperties(XDocument document, Dictionary<string, string> properties)
        {
            foreach (var group in document.Root?.Elements().Where(element => element.Name.LocalName == "PropertyGroup") ?? [])
            {
                if (!ConditionHolds(group.Attribute("Condition")?.Value, properties)) continue;
                foreach (var property in group.Elements())
                {
                    if (!ConditionHolds(property.Attribute("Condition")?.Value, properties)) continue;
                    properties[property.Name.LocalName] = Expand(property.Value, properties);
                }
            }
        }

        IEnumerable<string> DirectoryBuildProps(string directory)
        {
            var found = new List<string>();
            for (var current = directory; ; current = DirectoryOf(current))
            {
                var candidate = current.Length == 0 ? "Directory.Build.props" : current + "/Directory.Build.props";
                if (File.Exists(Path.Combine(root, candidate))) { found.Add(candidate); break; } // MSBuild imports only the nearest one
                if (current.Length == 0) break;
            }
            return found;
        }

        IEnumerable<string> Glob(string directory, string pattern)
        {
            foreach (var part in pattern.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (part.Contains("$(", StringComparison.Ordinal)) continue;
                var regex = new Regex("^" + Regex.Escape(Normalize(Combine(directory, part)) ?? "\0").Replace(@"\*\*/", "(.*/)?").Replace(@"\*\*", ".*").Replace(@"\*", "[^/]*").Replace(@"\?", "[^/]") + "$",
                    RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(200));
                foreach (var source in sourcePaths) if (regex.IsMatch(source)) yield return source;
            }
        }

        IndexedDiagnostic Diagnostic(string code, string severity, string message) => new("", null, code, severity, message, null);

        string[] Closure(string key)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal); var order = new List<string>(); var pending = new Stack<string>(direct[key].Reverse());
            while (pending.TryPop(out var next))
            {
                if (next == key || !seen.Add(next)) continue;
                order.Add(next);
                if (!directOnly.Contains(next)) foreach (var child in direct[next].Reverse()) pending.Push(child);
            }
            return order.ToArray();
        }

        // Project XML is untrusted repository content: bounded read, no DTD processing.
        XDocument Load(string relative)
        {
            var text = SourceFiles.Read(root, relative, cancellationToken).Text;
            using var reader = XmlReader.Create(new StringReader(text), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 4 * 1024 * 1024 });
            return XDocument.Load(reader);
        }
    }

    private static List<PassiveProject> BreakCycles(List<PassiveProject> projects)
    {
        var byKey = projects.ToDictionary(project => project.Key, StringComparer.Ordinal);
        var state = new Dictionary<string, int>(StringComparer.Ordinal); var kept = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var project in projects) Visit(project.Key);
        return projects.Select(project => project with { References = kept[project.Key].ToArray() }).ToList();
        void Visit(string key)
        {
            if (state.GetValueOrDefault(key) != 0) return;
            state[key] = 1; kept[key] = [];
            foreach (var reference in byKey[key].References ?? [])
            {
                if (state.GetValueOrDefault(reference) == 1) continue; // back edge: dropping it breaks the cycle
                Visit(reference); kept[key].Add(reference);
            }
            state[key] = 2;
        }
    }

    private static List<string> FindProjects(string root, IReadOnlyList<string> excludes, CancellationToken cancellationToken)
    {
        var found = new List<string>(); var pending = new Stack<string>(); pending.Push(root); var entries = 0;
        while (pending.TryPop(out var directory))
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory).Order(StringComparer.Ordinal))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (++entries > 200_000) throw new IOException("INPUT_TOO_LARGE: repository entry limit exceeded.");
                var relative = Path.GetRelativePath(root, entry).Replace('\\', '/');
                if (SourceScanner.IsExcluded(relative, excludes)) continue;
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                if ((attributes & FileAttributes.Directory) != 0) { if (!SkippedDirectories.Contains(Path.GetFileName(entry))) pending.Push(entry); continue; }
                if (entry.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)) found.Add(relative);
            }
        return GitFilePolicy.Filter(root, found, cancellationToken).Order(StringComparer.Ordinal).Take(MaximumProjects).ToList();
    }

    private static IEnumerable<MetadataInput> PackageReferences(string assetsPath, string framework, HashSet<string> frameworkReferences)
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(assetsPath), new JsonDocumentOptions { MaxDepth = 64 });
        var rootElement = document.RootElement;
        var folders = rootElement.TryGetProperty("packageFolders", out var packageFolders) ? packageFolders.EnumerateObject().Select(folder => folder.Name).ToArray() : [];
        if (!rootElement.TryGetProperty("targets", out var targets)) yield break;
        var target = targets.EnumerateObject().FirstOrDefault(entry => entry.Name.Equals(framework, StringComparison.OrdinalIgnoreCase) || entry.Name.StartsWith(Normalized(framework), StringComparison.OrdinalIgnoreCase));
        if (target.Value.ValueKind != JsonValueKind.Object) yield break;
        if (rootElement.TryGetProperty("project", out var project) && project.TryGetProperty("frameworks", out var frameworks))
            foreach (var entry in frameworks.EnumerateObject())
                if (entry.Value.TryGetProperty("frameworkReferences", out var declared))
                    foreach (var reference in declared.EnumerateObject()) frameworkReferences.Add(reference.Name);
        var libraries = rootElement.TryGetProperty("libraries", out var libraryList) ? libraryList : default;
        foreach (var package in target.Value.EnumerateObject())
        {
            if (!package.Value.TryGetProperty("type", out var type) || type.GetString() != "package" || !package.Value.TryGetProperty("compile", out var compile)) continue;
            if (package.Value.TryGetProperty("frameworkReferences", out var packageFrameworks))
                foreach (var reference in packageFrameworks.EnumerateArray()) if (reference.GetString() is { } name) frameworkReferences.Add(name);
            var libraryPath = libraries.ValueKind == JsonValueKind.Object && libraries.TryGetProperty(package.Name, out var library) && library.TryGetProperty("path", out var pathElement)
                ? pathElement.GetString() : package.Name.ToLowerInvariant();
            foreach (var file in compile.EnumerateObject())
            {
                if (!file.Name.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) continue; // "_._" placeholders and non-assemblies
                var located = folders.Select(folder => Path.GetFullPath(Path.Combine(folder, libraryPath ?? "", file.Name))).FirstOrDefault(File.Exists);
                if (located is not null && Hash(located) is { } hash) yield return new MetadataInput(located, hash);
            }
        }
    }

    private static IEnumerable<MetadataInput> FrameworkReferences(string framework, IEnumerable<string> names)
    {
        var version = FrameworkVersion(framework); if (version is null) yield break;
        foreach (var name in names.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var pack = DotnetRoots().Select(root => Path.Combine(root, "packs", name + ".Ref")).Where(Directory.Exists)
                .SelectMany(directory => Directory.EnumerateDirectories(directory))
                .Select(directory => (Directory: directory, Version: Version.TryParse(Path.GetFileName(directory).Split('-')[0], out var parsed) ? parsed : null))
                .Where(entry => entry.Version is not null && entry.Version.Major == version.Major && entry.Version.Minor == version.Minor
                    && Directory.Exists(Path.Combine(entry.Directory, "ref", framework)))
                .OrderByDescending(entry => entry.Version).Select(entry => Path.Combine(entry.Directory, "ref", framework)).FirstOrDefault();
            if (pack is null) continue;
            foreach (var file in Directory.EnumerateFiles(pack, "*.dll").Order(StringComparer.Ordinal))
                if (Hash(file) is { } hash) yield return new MetadataInput(file, hash);
        }
    }

    private static IEnumerable<MetadataInput> RuntimeAssemblies()
    {
        var trusted = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries) ?? [];
        var directory = Path.GetDirectoryName(typeof(object).Assembly.Location);
        foreach (var file in trusted.Where(file => Path.GetDirectoryName(file) == directory && Path.GetFileName(file) is var name
            && (name.StartsWith("System.", StringComparison.Ordinal) || name is "mscorlib.dll" or "netstandard.dll" or "Microsoft.CSharp.dll" or "Microsoft.VisualBasic.dll" or "Microsoft.Win32.Primitives.dll")).Order(StringComparer.Ordinal))
            if (Hash(file) is { } hash) yield return new MetadataInput(file, hash);
    }

    private static IEnumerable<string> DefaultDotnetRoots()
    {
        var candidates = new List<string?> { Environment.GetEnvironmentVariable("DOTNET_ROOT") };
        if (Environment.GetEnvironmentVariable("PRAXIS_DOTNET") is { Length: > 0 } dotnet) candidates.Add(Path.GetDirectoryName(Path.GetFullPath(dotnet)));
        if (OperatingSystem.IsWindows())
        {
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "dotnet"));
        }
        else
        {
            candidates.AddRange(["/usr/local/share/dotnet", "/usr/share/dotnet", "/usr/lib/dotnet", "/opt/homebrew/share/dotnet"]);
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dotnet"));
        }
        return candidates.OfType<string>().Where(Directory.Exists).Distinct(StringComparer.Ordinal);
    }

    private static string? Hash(string path)
    {
        try
        {
            var info = new FileInfo(path); if (!info.Exists || info.Length > 128 * 1024 * 1024) return null;
            if (Hashes.TryGetValue(path, out var cached) && cached.Length == info.Length && cached.Written == info.LastWriteTimeUtc) return cached.Hash;
            var hash = SourceFiles.Hash(PassiveManifest.ReadExternal(path)); Hashes[path] = (info.Length, info.LastWriteTimeUtc, hash); return hash;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    private static Version? FrameworkVersion(string framework)
    {
        var match = Regex.Match(framework, @"^net(\d+)\.(\d+)$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
        return match.Success && int.Parse(match.Groups[1].Value) >= 5 ? new Version(int.Parse(match.Groups[1].Value), int.Parse(match.Groups[2].Value)) : null;
    }

    private static string Normalized(string framework) => FrameworkVersion(framework) is { } version ? $"net{version.Major}.{version.Minor}" : framework;

    private static int FrameworkRank(string framework) => FrameworkVersion(framework) is { } version ? version.Major * 100 + version.Minor : 0;

    private static IEnumerable<string> FrameworkDefines(string framework)
    {
        if (FrameworkVersion(framework) is not { } version) yield break;
        yield return "NET"; yield return "NETCOREAPP"; yield return $"NET{version.Major}_{version.Minor}";
        for (var major = 5; major <= version.Major; major++) yield return $"NET{major}_0_OR_GREATER";
        foreach (var legacy in new[] { "1_0", "1_1", "2_0", "2_1", "2_2", "3_0", "3_1" }) yield return $"NETCOREAPP{legacy}_OR_GREATER";
    }

    // Only the conditions MSBuild projects commonly use for configuration are evaluated;
    // anything else is treated as false, so an unknown condition never adds a setting.
    private static bool ConditionHolds(string? condition, IReadOnlyDictionary<string, string> properties)
    {
        if (string.IsNullOrWhiteSpace(condition)) return true;
        var match = Regex.Match(condition, @"^\s*'\$\((\w+)\)(\|\$\(\w+\))?'\s*(==|!=)\s*'([^']*)'\s*$", RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
        if (!match.Success || match.Groups[2].Success) return false;
        var actual = properties.TryGetValue(match.Groups[1].Value, out var value) ? value : "";
        var equal = actual.Equals(match.Groups[4].Value, StringComparison.OrdinalIgnoreCase);
        return match.Groups[3].Value == "==" ? equal : !equal;
    }

    private static string Expand(string value, IReadOnlyDictionary<string, string> properties) =>
        Regex.Replace(value, @"\$\((\w+)\)", match => properties.TryGetValue(match.Groups[1].Value, out var replacement) ? replacement : match.Value,
            RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50)).Trim();

    private static IEnumerable<XElement> Items(XDocument document, string name) =>
        document.Root?.Elements().Where(element => element.Name.LocalName == "ItemGroup" && element.Attribute("Condition") is null)
            .SelectMany(group => group.Elements().Where(item => item.Name.LocalName == name && item.Attribute("Condition") is null)) ?? [];

    private static string DirectoryOf(string path) { var index = path.LastIndexOf('/'); return index < 0 ? "" : path[..index]; }
    private static bool Under(string path, string directory) => directory.Length == 0 || path.StartsWith(directory + "/", StringComparison.Ordinal);
    private static string Combine(string directory, string relative) => (directory.Length == 0 ? "" : directory + "/") + relative.Replace('\\', '/');
    private static string? Normalize(string path)
    {
        var parts = new List<string>();
        foreach (var part in path.Split('/'))
        {
            if (part is "" or ".") continue;
            if (part == "..") { if (parts.Count == 0) return null; parts.RemoveAt(parts.Count - 1); continue; }
            parts.Add(part);
        }
        return string.Join('/', parts);
    }
}
