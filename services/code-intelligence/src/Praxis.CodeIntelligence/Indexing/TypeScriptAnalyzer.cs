using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Praxis.CodeIntelligence.Indexing;

public sealed record TypeScriptConfigInput(string Path, string Hash, IReadOnlyList<string> References);
public sealed record TypeScriptDiscovery(IReadOnlyList<TypeScriptConfigInput> Configs, IReadOnlyList<SourceInput> SupportSources, IReadOnlyList<IndexedDiagnostic> Diagnostics);

/// <summary>
/// Passive TypeScript and JavaScript analysis via the trusted Node.js TypeScript compiler sidecar.
/// Never executes package scripts, tsconfig plugins, or untrusted code from the indexed repository.
/// </summary>
public sealed class TypeScriptAnalyzer
{
    public const string AdapterVersion = "typescript-7.0/v1";
    public const string ProtocolVersion = "1.0";

    private static readonly HashSet<string> ExcludedDirectories = new(StringComparer.OrdinalIgnoreCase)
    { ".git", "bin", "obj", "node_modules", "vendor", "dist", "coverage", ".idea", ".vs" };

    private static readonly JsonDocumentOptions ConfigJsonOptions = new()
    {
        CommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true
    };

    public static bool IsTypeScriptOrJavaScript(SourceInput source) =>
        source.Language is "typescript" or "javascript";

    public static TypeScriptDiscovery Discover(string root, IReadOnlyList<string> excludedPrefixes, CancellationToken cancellationToken = default)
    {
        root = SourceFiles.CanonicalDirectory(root);
        var configCandidates = new List<string>();
        var dtsCandidates = new List<string>();
        var directories = new Stack<string>();
        directories.Push(root);
        var entries = 0;

        while (directories.TryPop(out var directory))
        {
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory).Order(StringComparer.Ordinal))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (++entries > 200_000) throw new IOException("INPUT_TOO_LARGE: repository entry limit exceeded.");
                var relative = Path.GetRelativePath(root, entry).Replace('\\', '/');
                if (SourceScanner.IsExcluded(relative, excludedPrefixes)) continue;
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    if (!ExcludedDirectories.Contains(Path.GetFileName(entry))) directories.Push(entry);
                    continue;
                }

                var fileName = Path.GetFileName(entry);
                if (fileName.Equals("tsconfig.json", StringComparison.OrdinalIgnoreCase)
                    || fileName.Equals("jsconfig.json", StringComparison.OrdinalIgnoreCase))
                {
                    configCandidates.Add(relative);
                }
                else if (IsDeclarationFile(entry))
                {
                    dtsCandidates.Add(relative);
                }
            }
        }

        var allowedConfigs = GitFilePolicy.Filter(root, configCandidates, cancellationToken).ToHashSet(StringComparer.Ordinal);
        var allowedDts = GitFilePolicy.Filter(root, dtsCandidates, cancellationToken);

        var configs = new Dictionary<string, TypeScriptConfigInput>(StringComparer.Ordinal);
        var diagnostics = new List<IndexedDiagnostic>();
        var queue = new Queue<string>(allowedConfigs.OrderBy(x => x, StringComparer.Ordinal));

        while (queue.TryDequeue(out var configPath))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (configs.ContainsKey(configPath)) continue;
            if (SourceScanner.IsExcluded(configPath, excludedPrefixes)) continue;

            SourceInput configSource;
            try
            {
                configSource = SourceFiles.Read(root, configPath, cancellationToken);
            }
            catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
            {
                diagnostics.Add(new("", null, "PROJECT_INFERENCE_FAILED", "warning", $"TypeScript configuration '{configPath}' could not be read.", null));
                continue;
            }

            var references = new List<string>();
            try
            {
                using var doc = JsonDocument.Parse(configSource.Text, ConfigJsonOptions);
                var configDir = Path.GetDirectoryName(configPath)?.Replace('\\', '/') ?? "";
                if (doc.RootElement.ValueKind == JsonValueKind.Object
                    && doc.RootElement.TryGetProperty("references", out var refsElement)
                    && refsElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in refsElement.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.Object
                            || !item.TryGetProperty("path", out var pathProp)
                            || pathProp.ValueKind != JsonValueKind.String)
                            continue;
                        var rawRef = pathProp.GetString();
                        if (string.IsNullOrWhiteSpace(rawRef)) continue;
                        var resolvedRef = ResolveReferenceConfigPath(root, configDir, rawRef);
                        if (resolvedRef is not null && !SourceScanner.IsExcluded(resolvedRef, excludedPrefixes))
                        {
                            references.Add(resolvedRef);
                            if (!configs.ContainsKey(resolvedRef))
                                queue.Enqueue(resolvedRef);
                        }
                    }
                }
            }
            catch (JsonException)
            {
                diagnostics.Add(new("", null, "PROJECT_INFERENCE_FAILED", "warning", $"TypeScript configuration '{configPath}' contains invalid JSON.", null));
            }

            configs[configPath] = new TypeScriptConfigInput(configPath, configSource.Hash, references.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray());
        }

        var supportSources = new List<SourceInput>();
        foreach (var dtsPath in allowedDts.OrderBy(x => x, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var source = SourceFiles.Read(root, dtsPath, cancellationToken) with { Role = "semanticSupport" };
            supportSources.Add(source);
        }

        return new TypeScriptDiscovery(
            configs.Values.OrderBy(c => c.Path, StringComparer.Ordinal).ToArray(),
            supportSources,
            diagnostics);
    }

    public RepositoryAnalysis Analyze(
        string repositoryId,
        string repositoryRoot,
        IReadOnlyList<SourceInput> sources,
        IReadOnlyList<TypeScriptConfigInput> configs,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var searchable = sources.Where(s => s.Role == "searchableSource").ToArray();
        if (searchable.Length == 0)
            return new RepositoryAnalysis([], [], [], []);

        var sidecarScript = LocateSidecarScript();
        if (sidecarScript is null)
            return AnalyzeSyntaxOnlyFallback(repositoryId, searchable, "TYPESCRIPT_SIDECAR_UNAVAILABLE", "TypeScript compiler sidecar script was not found; indexed source using syntax-only analysis.", cancellationToken);

        var byPath = sources.ToDictionary(s => s.Path, StringComparer.Ordinal);
        var requestJson = JsonSerializer.Serialize(new
        {
            protocolVersion = ProtocolVersion,
            action = "index",
            repositoryId,
            root = repositoryRoot,
            configs = configs.Select(c => new
            {
                path = c.Path,
                hash = c.Hash,
                references = c.References
            }),
            sources = sources.Select(s => new
            {
                path = s.Path,
                hash = s.Hash,
                text = s.Text,
                language = s.Language,
                role = s.Role
            })
        });

        var nodeExecutable = Environment.GetEnvironmentVariable("PRAXIS_NODE_BINARY");
        if (string.IsNullOrWhiteSpace(nodeExecutable)) nodeExecutable = "node";

        var startInfo = new ProcessStartInfo
        {
            FileName = nodeExecutable,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = repositoryRoot,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        startInfo.ArgumentList.Add(sidecarScript);

        string stdoutLine;
        try
        {
            using var process = Process.Start(startInfo)
                ?? throw new IOException("Failed to start Node.js process for TypeScript sidecar.");
            using var registration = cancellationToken.Register(() =>
            {
                try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
                catch { /* Best-effort kill on cancellation */ }
            });

            var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
            process.StandardInput.WriteLine(requestJson);
            process.StandardInput.Close();

            var line = process.StandardOutput.ReadLine();
            process.WaitForExit();
            _ = stderrTask.GetAwaiter().GetResult();
            cancellationToken.ThrowIfCancellationRequested();

            if (string.IsNullOrWhiteSpace(line))
                throw new IOException($"TypeScript sidecar exited with code {process.ExitCode} without returning a response.");
            stdoutLine = line;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex) when (ex is IOException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return AnalyzeSyntaxOnlyFallback(repositoryId, searchable, "TYPESCRIPT_SIDECAR_FAILED", $"TypeScript compiler sidecar could not be executed ({ex.Message}); indexed source using syntax-only analysis.", cancellationToken);
        }

        using var doc = JsonDocument.Parse(stdoutLine);
        var rootEl = doc.RootElement;
        if (!rootEl.TryGetProperty("protocolVersion", out var protoProp) || protoProp.GetString() != ProtocolVersion)
        {
            return AnalyzeSyntaxOnlyFallback(repositoryId, searchable, "TYPESCRIPT_SIDECAR_PROTOCOL_MISMATCH", "TypeScript compiler sidecar returned an incompatible protocol version; indexed source using syntax-only analysis.", cancellationToken);
        }

        if (rootEl.TryGetProperty("error", out var errorProp) && errorProp.ValueKind == JsonValueKind.Object)
        {
            var code = errorProp.TryGetProperty("code", out var c) ? c.GetString() ?? "SIDECAR_FAILED" : "SIDECAR_FAILED";
            var msg = errorProp.TryGetProperty("message", out var m) ? m.GetString() ?? "TypeScript sidecar error." : "TypeScript sidecar error.";
            if (code == "IDENTITY_COLLISION") throw new InvalidOperationException("IDENTITY_COLLISION");
            return AnalyzeSyntaxOnlyFallback(repositoryId, searchable, code, $"TypeScript compiler sidecar failed ({msg}); indexed source using syntax-only analysis.", cancellationToken);
        }

        var adapterVersion = rootEl.TryGetProperty("adapterVersion", out var avProp) && avProp.GetString() is { Length: > 0 } av
            ? av
            : AdapterVersion;

        var contexts = new List<IndexedContext>();
        if (rootEl.TryGetProperty("contexts", out var ctxArray) && ctxArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in ctxArray.EnumerateArray())
            {
                var key = item.GetProperty("key").GetString()!;
                var projectPath = item.GetProperty("projectPath").GetString()!;
                var id = item.GetProperty("id").GetString()!;
                var hash = item.GetProperty("hash").GetString()!;
                var resolution = item.GetProperty("resolution").GetString()!;
                var language = item.TryGetProperty("language", out var langProp) && langProp.GetString() is { Length: > 0 } l ? l : "typescript";
                var ctxAdapter = item.TryGetProperty("adapterVersion", out var caProp) && caProp.GetString() is { Length: > 0 } ca ? ca : adapterVersion;
                var ctxSources = new List<SourceInput>();
                if ((item.TryGetProperty("sourcePaths", out var srcArr) || item.TryGetProperty("sources", out srcArr))
                    && srcArr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var sEl in srcArr.EnumerateArray())
                    {
                        var path = sEl.GetString()!;
                        if (byPath.TryGetValue(path, out var sourceInput))
                            ctxSources.Add(sourceInput);
                    }
                }
                contexts.Add(new IndexedContext(key, projectPath, id, hash, resolution, ctxSources, language, ctxAdapter));
            }
        }

        var symbols = new List<IndexedSymbol>();
        if (rootEl.TryGetProperty("symbols", out var symArray) && symArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in symArray.EnumerateArray())
            {
                var locations = new List<IndexedLocation>();
                if (item.TryGetProperty("locations", out var locArr) && locArr.ValueKind == JsonValueKind.Array)
                {
                    foreach (var loc in locArr.EnumerateArray())
                    {
                        var rangeEl = loc.GetProperty("range");
                        var startEl = rangeEl.GetProperty("start");
                        var endEl = rangeEl.GetProperty("end");
                        locations.Add(new IndexedLocation(
                            loc.GetProperty("id").GetString()!,
                            loc.GetProperty("contextId").GetString()!,
                            loc.GetProperty("filePath").GetString()!,
                            loc.GetProperty("hash").GetString()!,
                            loc.GetProperty("start").GetInt32(),
                            loc.GetProperty("end").GetInt32(),
                            new SourceRange(
                                new Position(startEl.GetProperty("line").GetInt32(), startEl.GetProperty("character").GetInt32()),
                                new Position(endEl.GetProperty("line").GetInt32(), endEl.GetProperty("character").GetInt32()))));
                    }
                }

                var containerId = item.TryGetProperty("containerId", out var contProp) && contProp.ValueKind == JsonValueKind.String
                    ? contProp.GetString()
                    : null;

                symbols.Add(new IndexedSymbol(
                    item.GetProperty("id").GetString()!,
                    item.GetProperty("identity").GetString()!,
                    item.GetProperty("contextId").GetString() ?? "",
                    item.GetProperty("kind").GetString()!,
                    item.GetProperty("name").GetString()!,
                    item.GetProperty("qualifiedName").GetString()!,
                    item.GetProperty("signature").GetString()!,
                    item.GetProperty("revision").GetString()!,
                    item.GetProperty("resolution").GetString()!,
                    containerId,
                    item.GetProperty("external").GetBoolean(),
                    item.GetProperty("documentation").GetString() ?? "",
                    locations));

                if (symbols.Count > 50_000)
                    throw new IOException("INPUT_TOO_LARGE: symbol limit exceeded.");
            }
        }

        static List<IndexedCall> ParseCalls(JsonElement parent, string propertyName)
        {
            var result = new List<IndexedCall>();
            if (!parent.TryGetProperty(propertyName, out var arr) || arr.ValueKind != JsonValueKind.Array)
                return result;
            foreach (var item in arr.EnumerateArray())
            {
                var rangeEl = item.GetProperty("range");
                var startEl = rangeEl.GetProperty("start");
                var endEl = rangeEl.GetProperty("end");
                var targetId = item.TryGetProperty("targetId", out var tProp) && tProp.ValueKind == JsonValueKind.String
                    ? tProp.GetString()
                    : null;
                var kind = item.TryGetProperty("kind", out var kProp) && kProp.ValueKind == JsonValueKind.String
                    ? kProp.GetString()!
                    : "calls";
                result.Add(new IndexedCall(
                    item.GetProperty("id").GetString()!,
                    item.GetProperty("contextId").GetString()!,
                    item.GetProperty("filePath").GetString()!,
                    item.GetProperty("hash").GetString()!,
                    item.GetProperty("ownerId").GetString()!,
                    targetId,
                    item.GetProperty("start").GetInt32(),
                    item.GetProperty("end").GetInt32(),
                    new SourceRange(
                        new Position(startEl.GetProperty("line").GetInt32(), startEl.GetProperty("character").GetInt32()),
                        new Position(endEl.GetProperty("line").GetInt32(), endEl.GetProperty("character").GetInt32())),
                    item.GetProperty("resolution").GetString()!,
                    kind));
            }
            return result;
        }

        var calls = ParseCalls(rootEl, "calls");
        var relationships = ParseCalls(rootEl, "relationships");

        var configuredDependencies = new List<IndexedDependency>();
        if (rootEl.TryGetProperty("configuredDependencies", out var depArr) && depArr.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in depArr.EnumerateArray())
            {
                var targetCtx = item.TryGetProperty("targetContextId", out var tcProp) && tcProp.ValueKind == JsonValueKind.String
                    ? tcProp.GetString()
                    : null;
                var reqHash = item.TryGetProperty("requiredContextHash", out var rhProp) && rhProp.ValueKind == JsonValueKind.String
                    ? rhProp.GetString()
                    : null;
                configuredDependencies.Add(new IndexedDependency(
                    item.GetProperty("id").GetString()!,
                    item.GetProperty("contextId").GetString()!,
                    item.GetProperty("ownerId").GetString()!,
                    item.GetProperty("targetId").GetString()!,
                    item.GetProperty("inputRevision").GetString()!,
                    item.GetProperty("resolution").GetString()!,
                    item.GetProperty("referenceIdentity").GetString()!,
                    targetCtx,
                    reqHash));
            }
        }

        var diagnostics = new List<IndexedDiagnostic>();
        if (rootEl.TryGetProperty("diagnostics", out var diagArr) && diagArr.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in diagArr.EnumerateArray())
            {
                var filePath = item.TryGetProperty("filePath", out var fpProp) && fpProp.ValueKind == JsonValueKind.String
                    ? fpProp.GetString()
                    : null;
                SourceRange? range = null;
                if (item.TryGetProperty("range", out var rProp) && rProp.ValueKind == JsonValueKind.Object)
                {
                    var s = rProp.GetProperty("start");
                    var e = rProp.GetProperty("end");
                    range = new SourceRange(
                        new Position(s.GetProperty("line").GetInt32(), s.GetProperty("character").GetInt32()),
                        new Position(e.GetProperty("line").GetInt32(), e.GetProperty("character").GetInt32()));
                }
                diagnostics.Add(new IndexedDiagnostic(
                    item.GetProperty("contextId").GetString() ?? "",
                    filePath,
                    item.GetProperty("code").GetString()!,
                    item.GetProperty("severity").GetString()!,
                    item.GetProperty("message").GetString()!,
                    range));
            }
        }

        return new RepositoryAnalysis(contexts, symbols, calls, diagnostics)
        {
            Relationships = relationships,
            ConfiguredDependencies = configuredDependencies
        };
    }

    private static RepositoryAnalysis AnalyzeSyntaxOnlyFallback(
        string repositoryId,
        IReadOnlyList<SourceInput> sources,
        string diagnosticCode,
        string diagnosticMessage,
        CancellationToken cancellationToken)
    {
        var key = "ts-syntax";
        var ctxId = Identity.Id("pci:ctx:", repositoryId, key);
        var language = sources.All(s => s.Language == "javascript") ? "javascript" : "typescript";
        var ctxHash = SourceFiles.Hash(Encoding.UTF8.GetBytes(
            AdapterVersion + key + "|" + string.Join("|", sources.Select(s => $"{s.Path}:{s.Hash}"))));
        var context = new IndexedContext(key, "", ctxId, ctxHash, "syntaxOnly", sources, language, AdapterVersion);

        var symbols = new Dictionary<string, IndexedSymbol>(StringComparer.Ordinal);
        var rootIdentity = Identity.Json(1, "synthetic", repositoryId, ctxId, "projectRoot");
        var rootId = Identity.Id("pci:syntactic:", rootIdentity);
        symbols[rootId] = new IndexedSymbol(
            rootId, rootIdentity, ctxId, "module", "[synthetic projectRoot]",
            key + " [synthetic projectRoot]", "[synthetic projectRoot]",
            ctxHash, "syntaxOnly", null, false,
            "Synthetic context containment root; not a source declaration.", []);

        var declPattern = new Regex(
            @"(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?<kw>class|interface|type|enum|namespace|function|const|let|var)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)",
            RegexOptions.Compiled);

        foreach (var source in sources)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var moduleQualifier = Regex.Replace(source.Path, @"\.([cm]?[tj]sx?)$", "", RegexOptions.IgnoreCase);
            var lineStarts = ComputeLineStarts(source.Text);
            foreach (Match match in declPattern.Matches(source.Text))
            {
                var kw = match.Groups["kw"].Value;
                var name = match.Groups["name"].Value;
                var kind = kw switch
                {
                    "class" or "interface" or "type" or "enum" => "type",
                    "namespace" => "namespace",
                    "function" => "method",
                    _ => "field"
                };
                var qualifiedName = $"{moduleQualifier}.{name}";
                var descriptor = kind == "method" ? $"{qualifiedName}()" : qualifiedName;
                var identity = Identity.Json(1, "source", repositoryId, key, ctxId, source.Language, kind, descriptor);
                var symId = Identity.Id("pci:syntactic:", identity);
                var start = match.Index + (match.Value.StartsWith('\n') ? 1 : 0);
                var end = match.Index + match.Length;
                var range = OffsetRange(lineStarts, start, end);
                var locId = Identity.Id("pci:loc:", symId, ctxId, source.Path, source.Hash, start, end);
                var location = new IndexedLocation(locId, ctxId, source.Path, source.Hash, start, end, range);
                var revision = SourceFiles.Hash(Encoding.UTF8.GetBytes(match.Value.Trim() + ctxHash));
                symbols[symId] = new IndexedSymbol(
                    symId, identity, ctxId, kind, name, qualifiedName,
                    $"{kw} {qualifiedName}", revision, "syntaxOnly", rootId, false, "", [location]);
            }
        }

        var diagnostic = new IndexedDiagnostic(ctxId, null, diagnosticCode, "warning", diagnosticMessage, null);
        return new RepositoryAnalysis([context], symbols.Values.OrderBy(s => s.Id, StringComparer.Ordinal).ToArray(), [], [diagnostic]);
    }

    private static int[] ComputeLineStarts(string text)
    {
        var starts = new List<int> { 0 };
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] == '\n') starts.Add(i + 1);
        }
        return starts.ToArray();
    }

    private static SourceRange OffsetRange(int[] lineStarts, int start, int end)
    {
        static Position ToPosition(int[] starts, int offset)
        {
            var idx = Array.BinarySearch(starts, offset);
            if (idx < 0) idx = ~idx - 1;
            return new Position(idx, offset - starts[idx]);
        }
        return new SourceRange(ToPosition(lineStarts, start), ToPosition(lineStarts, end));
    }

    private static bool IsDeclarationFile(string path) =>
        path.EndsWith(".d.ts", StringComparison.OrdinalIgnoreCase)
        || path.EndsWith(".d.mts", StringComparison.OrdinalIgnoreCase)
        || path.EndsWith(".d.cts", StringComparison.OrdinalIgnoreCase);

    private static string? ResolveReferenceConfigPath(string root, string configDir, string rawRef)
    {
        var combined = Path.GetFullPath(Path.Combine(root, configDir, rawRef.Replace('/', Path.DirectorySeparatorChar)));
        var canonicalRoot = SourceFiles.CanonicalDirectory(root);
        if (!combined.StartsWith(canonicalRoot + Path.DirectorySeparatorChar, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)
            && !string.Equals(combined, canonicalRoot, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            return null;

        string candidateFile;
        if (Directory.Exists(combined))
        {
            candidateFile = Path.Combine(combined, "tsconfig.json");
            if (!File.Exists(candidateFile))
                candidateFile = Path.Combine(combined, "jsconfig.json");
        }
        else if (File.Exists(combined))
        {
            candidateFile = combined;
        }
        else if (!combined.EndsWith(".json", StringComparison.OrdinalIgnoreCase) && File.Exists(combined + ".json"))
        {
            candidateFile = combined + ".json";
        }
        else
        {
            return null;
        }

        if (!File.Exists(candidateFile)) return null;
        var relative = Path.GetRelativePath(canonicalRoot, candidateFile).Replace('\\', '/');
        try
        {
            SourceFiles.Resolve(canonicalRoot, relative);
            return relative;
        }
        catch
        {
            return null;
        }
    }

    private static string? LocateSidecarScript()
    {
        var envOverride = Environment.GetEnvironmentVariable("PRAXIS_TS_SIDECAR_PATH");
        if (!string.IsNullOrWhiteSpace(envOverride) && File.Exists(envOverride))
            return Path.GetFullPath(envOverride);

        var baseDirCandidate = Path.Combine(AppContext.BaseDirectory, "ts-sidecar.mjs");
        if (File.Exists(baseDirCandidate))
            return baseDirCandidate;

        var current = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 10 && current is not null; i++)
        {
            var direct = Path.Combine(current.FullName, "scripts", "ts-sidecar.mjs");
            if (File.Exists(direct)) return direct;
            var underService = Path.Combine(current.FullName, "services", "code-intelligence", "scripts", "ts-sidecar.mjs");
            if (File.Exists(underService)) return underService;
            current = current.Parent;
        }
        return null;
    }
}
