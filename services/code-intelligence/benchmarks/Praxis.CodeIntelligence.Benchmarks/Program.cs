using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Embeddings;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;

var options = new Dictionary<string, string>(StringComparer.Ordinal);
if (args.Length % 2 != 0) throw new ArgumentException("Expected flag/value pairs.");
for (var i = 0; i < args.Length; i += 2)
    if (args[i] is not ("--symbols" or "--queries" or "--output" or "--model") || !options.TryAdd(args[i], args[i + 1]))
        throw new ArgumentException("Unknown or duplicate flag.");
var symbols = int.Parse(options.GetValueOrDefault("--symbols", "5000"));
var queries = int.Parse(options.GetValueOrDefault("--queries", "100"));
if (symbols is < 100 or > 49999 || queries is < 10 or > 1000) throw new ArgumentException("Symbols must be 100–49999 source symbols (50000 total including metadata); queries 10–1000 per reader.");
var output = Path.GetFullPath(options.GetValueOrDefault("--output", "benchmark.praxis.json"));
if (!output.EndsWith(".praxis.json", StringComparison.Ordinal)) throw new ArgumentException("Output must end in .praxis.json.");
var temporary = Path.Combine(Path.GetTempPath(), "praxis-benchmark-" + Guid.NewGuid().ToString("N"));
var root = Path.Combine(temporary, "source"); Directory.CreateDirectory(root);
try
{
    var paths = new List<string>(); var names = new List<string>(); var hashes = new List<string>();
    var remaining = symbols - 1; var ordinal = 0;
    while (remaining > 0)
    {
        var name = $"Corpus{paths.Count:D4}"; var path = name + ".cs";
        var text = new StringBuilder($"public class {name} {{\n");
        var count = Math.Min(99, remaining - 1);
        for (var i = 0; i < count; i++)
        {
            var method = $"TokenParser{ordinal:D5}"; names.Add(method);
            text.Append($"/// <summary>Parse authentication token category {ordinal}.</summary>\npublic static int {method}(int value) => value + {ordinal};\n"); ordinal++;
        }
        text.Append("}\n"); var source = text.ToString();
        File.WriteAllText(Path.Combine(root, path), source); paths.Add(path);
        hashes.Add(path + ":" + SourceFiles.Hash(Encoding.UTF8.GetBytes(source))); remaining -= count + 1;
    }
    var assembly = typeof(object).Assembly.Location; var referenceHash = SourceFiles.Hash(File.ReadAllBytes(assembly));
    var manifest = new PassiveManifest(1, [new("benchmark", "Benchmark", paths.ToArray(), Metadata: [new(assembly, referenceHash)])]);
    File.WriteAllText(Path.Combine(root, "context.praxis.json"), JsonSerializer.Serialize(manifest));
    var database = new IndexDatabase(Path.Combine(temporary, "data", "index.db")); database.Initialize();
    var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root, new("context.praxis.json"));
    Console.Error.WriteLine($"Indexing {symbols} generated symbols.");
    var watch = Stopwatch.StartNew(); var initial = indexer.Index(repository); var initialMs = watch.Elapsed.TotalMilliseconds;
    int sourceSymbols;
    using (var read = database.Open(readOnly: true))
    using (var count = read.CreateCommand())
    {
        count.CommandText = "SELECT count(*) FROM symbols WHERE external=0";
        sourceSymbols = Convert.ToInt32(count.ExecuteScalar());
    }
    if (sourceSymbols != symbols) throw new InvalidOperationException($"Expected {symbols} source symbols, got {sourceSymbols}.");
    using var models = new ModelStore(database, Path.Combine(temporary, "models"));
    string? fingerprint = null; double? initialVectorsMs = null;
    if (options.TryGetValue("--model", out var bundle))
    {
        Console.Error.WriteLine("Installing model and building vectors."); fingerprint = models.Install(bundle);
        watch.Restart(); models.Activate(repository, fingerprint, CancellationToken.None); initialVectorsMs = watch.Elapsed.TotalMilliseconds;
    }
    var service = new QueryService(database, models); var allowed = new HashSet<string> { repository };
    void Search(string mode, int index)
    {
        var response = service.Execute("search_code", new JsonObject { ["repositoryId"] = repository, ["query"] = names[index % names.Count], ["mode"] = mode, ["limit"] = 10, ["responseBudgetTokens"] = 8000 }, allowed);
        if (response["error"] is not null || response["data"]?["matches"] is not JsonArray matches || matches.Count == 0)
            throw new InvalidOperationException("Search failed: " + response.ToJsonString());
        if (mode == "hybrid" && (response["data"]?["channelsUsed"] is not JsonArray channels
            || !channels.Any(channel => channel?.GetValue<string>() == "vector")
            || response["data"]?["vectorCoveredSymbolCount"]?.GetValue<long>() != sourceSymbols))
            throw new InvalidOperationException("Hybrid benchmark requires complete real vector coverage.");
    }
    async Task<object> Measure(string mode)
    {
        for (var i = 0; i < 20; i++) Search(mode, i);
        var times = new ConcurrentBag<double>(); using var start = new Barrier(4);
        await Task.WhenAll(Enumerable.Range(0, 4).Select(reader => Task.Run(() =>
        {
            start.SignalAndWait();
            for (var i = 0; i < queries; i++)
            {
                var timer = Stopwatch.StartNew(); Search(mode, i * 17 + reader); times.Add(timer.Elapsed.TotalMilliseconds);
            }
        })));
        var values = times.Order().ToArray();
        return new Timing(4, values.Length, values[(int)Math.Ceiling(values.Length * .5) - 1], values[(int)Math.Ceiling(values.Length * .95) - 1], values[^1]);
    }
    Console.Error.WriteLine("Measuring four-reader lexical queries."); var lexical = (Timing)await Measure("lexical");
    Timing? hybrid = null;
    if (fingerprint is not null) { Console.Error.WriteLine("Measuring four-reader hybrid queries."); hybrid = (Timing)await Measure("hybrid"); }
    watch.Restart(); var unchanged = indexer.Index(repository); var noOpMs = watch.Elapsed.TotalMilliseconds;
    if (unchanged.Changed) throw new InvalidOperationException("Unchanged index republished.");
    var first = Path.Combine(root, paths[0]); var before = File.ReadAllText(first); var after = before.Replace("=> value + 0;", "=> value + 2;", StringComparison.Ordinal);
    if (before == after) throw new InvalidOperationException("Edit did not change source."); File.WriteAllText(first, after);
    Console.Error.WriteLine("Measuring body edit publication.");
    watch.Restart(); var edited = indexer.Index(repository); var editMs = watch.Elapsed.TotalMilliseconds;
    if (!edited.Changed || edited.Generation != initial.Generation + 1) throw new InvalidOperationException("Edit failed to publish.");
    double? refreshMs = null;
    if (fingerprint is not null) { watch.Restart(); models.Activate(repository, fingerprint, CancellationToken.None); refreshMs = watch.Elapsed.TotalMilliseconds; }
    var rss = Process.GetCurrentProcess().PeakWorkingSet64;
    using var connection = database.Open(readOnly: true); using var command = connection.CreateCommand(); command.CommandText = "SELECT sqlite_version()";
    var gates = new Dictionary<string, bool?>
    {
        ["lexicalP95AtMost100Ms"] = lexical.P95Ms <= 100,
        ["hybridP95AtMost500Ms"] = hybrid is null ? null : hybrid.P95Ms <= 500,
        ["fiveThousandSymbolBodyEditAtMost2Seconds"] = symbols == 5000 ? editMs <= 2000 : null,
        ["fiveThousandSymbolSemanticRefreshAtMost10Seconds"] = symbols == 5000 && refreshMs.HasValue ? refreshMs <= 10000 : null,
        ["peakRssAtMost2GiB"] = rss <= 2L * 1024 * 1024 * 1024
    };
    var report = new
    {
        Version = 1, ThresholdDefinitionVersion = 2, VectorScorerVersion = ModelStore.VectorScorerVersion, StorageSchemaVersion = IndexDatabase.SchemaVersion, AdapterVersion = RoslynAnalyzer.AdapterVersion, OnnxInterOpThreads = 1, OnnxIntraOpThreads = Math.Clamp(Environment.ProcessorCount, 1, 4), TimestampUtc = DateTimeOffset.UtcNow, ExecutionMode = "Direct service API; owner/MCP transport excluded",
#if DEBUG
        BuildConfiguration = "Debug",
#else
        BuildConfiguration = "Release",
#endif
        OperatingSystem = RuntimeInformation.OSDescription, Architecture = RuntimeInformation.ProcessArchitecture.ToString(),
        LogicalProcessors = Environment.ProcessorCount, Runtime = RuntimeInformation.FrameworkDescription, Sqlite = command.ExecuteScalar(),
        ModelFingerprint = fingerprint, RequestedSymbols = symbols, PublishedSymbols = initial.Symbols, PublishedSourceSymbols = sourceSymbols, SourceFiles = paths.Count,
        CorpusHash = SourceFiles.Hash(Encoding.UTF8.GetBytes(string.Join("\n", hashes))), ReferenceAssemblyHash = referenceHash,
        InitialIndexMs = initialMs, InitialVectorsMs = initialVectorsMs, Lexical = lexical, Hybrid = hybrid,
        NoOpIndexMs = noOpMs, BodyEditMs = editMs, VectorRefreshMs = refreshMs, EditToVectorsMs = refreshMs.HasValue ? editMs + refreshMs : (double?)null, PeakRssBytes = rss, Gates = gates,
        Unmeasured = new[] { "owner/native IPC", "MCP/provider transport", "held-out relevance", "other platforms", "representative real repository", "edit p95 including watcher debounce", "retrieval-only latency" }.Concat(initial.Symbols < 50000 ? new[] { "50k-symbol capacity" } : fingerprint is null ? new[] { "50k-symbol hybrid capacity" } : Array.Empty<string>()).ToArray(),
        PassedMeasuredGates = gates.Values.All(value => value != false)
    };
    Directory.CreateDirectory(Path.GetDirectoryName(output)!);
    File.WriteAllText(output, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }) + "\n");
    Console.WriteLine(output); Console.WriteLine(JsonSerializer.Serialize(gates));
    return report.PassedMeasuredGates ? 0 : 2;
}
finally { Directory.Delete(temporary, recursive: true); }

internal sealed record Timing(int Readers, int Count, double P50Ms, double P95Ms, double MaximumMs);
