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
    if (args[i] is not ("--symbols" or "--queries" or "--output" or "--model" or "--retain-fixture" or "--reuse-fixture" or "--readers" or "--runs" or "--category" or "--concurrent-edits") || !options.TryAdd(args[i], args[i + 1]))
        throw new ArgumentException("Unknown or duplicate flag.");
var symbols = int.Parse(options.GetValueOrDefault("--symbols", "5000"));
var queries = int.Parse(options.GetValueOrDefault("--queries", "100"));
if (symbols is < 100 or > 49999 || queries is < 10 or > 1000) throw new ArgumentException("Symbols must be 100–49999 source symbols (50000 total including metadata); queries 10–1000 per reader.");
var output = Path.GetFullPath(options.GetValueOrDefault("--output", "benchmark.praxis.json"));
if (!output.EndsWith(".praxis.json", StringComparison.Ordinal)) throw new ArgumentException("Output must end in .praxis.json.");
var category = options.GetValueOrDefault("--category", "exact");
if (category is not ("exact" or "terminology" or "behaviour" or "negative")) throw new ArgumentException("Unsupported query category.");
if (options.ContainsKey("--category") && !options.ContainsKey("--reuse-fixture")) throw new ArgumentException("Query categories require a retained fixture.");
var concurrentEdits = int.Parse(options.GetValueOrDefault("--concurrent-edits", "0"));
if (concurrentEdits is not 0 and (< 5 or > 100)) throw new ArgumentException("--concurrent-edits expects 5–100.");
if (concurrentEdits > 0 && (options.ContainsKey("--reuse-fixture") || !options.ContainsKey("--model")))
    throw new ArgumentException("Concurrent edits need a fresh fixture with a model; retained fixtures are never edited.");
var readers = int.Parse(options.GetValueOrDefault("--readers", "4"));
var runs = int.Parse(options.GetValueOrDefault("--runs", "1"));
if (readers is not (1 or 4) || runs is < 1 or > 5) throw new ArgumentException("Readers must be 1 or 4; runs 1–5.");
if (!options.ContainsKey("--reuse-fixture") && (options.ContainsKey("--readers") || options.ContainsKey("--runs")))
    throw new ArgumentException("Reader/run selection requires a retained query fixture.");
var retain = options.GetValueOrDefault("--retain-fixture", "false");
if (retain is not ("true" or "false")) throw new ArgumentException("--retain-fixture expects true or false.");
if (options.TryGetValue("--reuse-fixture", out var existing))
{
    if (options.ContainsKey("--model") || options.ContainsKey("--symbols") || retain == "true")
        throw new ArgumentException("Reuse accepts only a retained fixture, queries and output; it never republishes or installs models.");
    try { return await RetainedBenchmark.Run(existing, queries, output, readers, runs, category); }
    catch (Exception error) when (error is IOException or ArgumentException or JsonException
        or UnauthorizedAccessException or InvalidOperationException or KeyNotFoundException)
    {
        Console.Error.WriteLine("Retained fixture rejected: " + error.Message); return 3;
    }
}
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
    var metrics = new QueryMetrics(); var service = new QueryService(database, models) { MeasurementObserver = metrics.Record }; var allowed = new HashSet<string> { repository };
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
    Console.Error.WriteLine("Measuring four-reader lexical queries."); var lexical = await RetainedBenchmark.Measure(Search, "lexical", queries, metrics: metrics);
    Timing? hybrid = null;
    if (fingerprint is not null) { Console.Error.WriteLine("Measuring four-reader hybrid queries."); hybrid = await RetainedBenchmark.Measure(Search, "hybrid", queries, metrics: metrics); }
    watch.Restart(); var unchanged = indexer.Index(repository); var noOpMs = watch.Elapsed.TotalMilliseconds;
    if (unchanged.Changed) throw new InvalidOperationException("Unchanged index republished.");
    var first = Path.Combine(root, paths[0]); var before = File.ReadAllText(first); var after = before.Replace("=> value + 0;", "=> value + 2;", StringComparison.Ordinal);
    if (before == after) throw new InvalidOperationException("Edit did not change source."); File.WriteAllText(first, after);
    Console.Error.WriteLine("Measuring body edit publication.");
    watch.Restart(); var edited = indexer.Index(repository); var editMs = watch.Elapsed.TotalMilliseconds;
    if (!edited.Changed || edited.Generation != initial.Generation + 1) throw new InvalidOperationException("Edit failed to publish.");
    double? refreshMs = null;
    if (fingerprint is not null) { watch.Restart(); models.Activate(repository, fingerprint, CancellationToken.None); refreshMs = watch.Elapsed.TotalMilliseconds; }
    object? concurrent = null; bool? concurrentPassed = null;
    if (concurrentEdits > 0)
    {
        // Real edits publish and refresh vectors while four readers alternate
        // lexical/hybrid queries until the writer finishes. Coverage may dip
        // during refresh; any query error or missing channel is a failure.
        Console.Error.WriteLine($"Measuring queries during {concurrentEdits} concurrent edits.");
        var times = new[] { new ConcurrentBag<double>(), new ConcurrentBag<double>() };
        var failures = new ConcurrentQueue<string>(); int errors = 0; long minimumCoverage = long.MaxValue;
        var edits = new List<object>(); var writerDone = 0;
        void Fail(Exception error) { Interlocked.Increment(ref errors); if (failures.Count < 10) failures.Enqueue(error.GetType().Name + ": " + error.Message); }
        void ConcurrentSearch(string mode, int index)
        {
            var response = service.Execute("search_code", new JsonObject { ["repositoryId"] = repository, ["query"] = names[index % names.Count], ["mode"] = mode, ["limit"] = 10, ["responseBudgetTokens"] = 8000 }, allowed);
            if (response["error"] is not null || response["data"]?["matches"] is not JsonArray { Count: > 0 })
                throw new InvalidOperationException("Search failed: " + response.ToJsonString());
            if (mode != "hybrid") return;
            if (response["data"]?["channelsUsed"] is not JsonArray channels || !channels.Any(channel => channel?.GetValue<string>() == "vector"))
                throw new InvalidOperationException("Hybrid query lost the vector channel during edits.");
            var covered = response["data"]?["vectorCoveredSymbolCount"]?.GetValue<long>() ?? 0;
            long seen; do seen = Interlocked.Read(ref minimumCoverage); while (covered < seen && Interlocked.CompareExchange(ref minimumCoverage, covered, seen) != seen);
        }
        var writer = Task.Run(() =>
        {
            try
            {
                for (var edit = 1; edit <= concurrentEdits; edit++)
                {
                    var file = Path.Combine(root, paths[edit % paths.Count]); var text = File.ReadAllText(file);
                    var marker = text.IndexOf("=> value + ", StringComparison.Ordinal); var end = text.IndexOf(';', marker);
                    var changed = text[..(marker + 11)] + (long.Parse(text[(marker + 11)..end]) + 1_000_000) + text[end..];
                    File.WriteAllText(file, changed);
                    var timer = Stopwatch.StartNew(); var published = indexer.Index(repository); var publishMs = timer.Elapsed.TotalMilliseconds;
                    if (!published.Changed) throw new InvalidOperationException("Concurrent edit did not publish.");
                    timer.Restart(); models.Activate(repository, fingerprint!, CancellationToken.None);
                    lock (edits) edits.Add(new { Edit = edit, PublishMs = publishMs, RefreshMs = timer.Elapsed.TotalMilliseconds });
                }
            }
            catch (Exception error) when (error is not OutOfMemoryException) { Fail(error); }
            finally { Volatile.Write(ref writerDone, 1); }
        });
        metrics.Begin();
        await Task.WhenAll(Enumerable.Range(0, 4).Select(reader => Task.Run(() =>
        {
            for (var i = 0; Volatile.Read(ref writerDone) == 0; i++)
            {
                var mode = i % 2 == 0 ? "lexical" : "hybrid"; var timer = Stopwatch.StartNew();
                try { ConcurrentSearch(mode, (i * 4 + reader) * 17); }
                catch (Exception error) when (error is not OutOfMemoryException) { Fail(error); }
                finally { times[i % 2].Add(timer.Elapsed.TotalMilliseconds); }
            }
        })));
        await writer; var phases = metrics.End();
        object Summary(ConcurrentBag<double> bag)
        {
            var values = bag.Order().ToArray(); double? At(double fraction) => values.Length == 0 ? null : values[(int)Math.Ceiling(values.Length * fraction) - 1];
            return new { Count = values.Length, P50Ms = At(.5), P95Ms = At(.95), P99Ms = At(.99), MaximumMs = At(1) };
        }
        double? P95(ConcurrentBag<double> bag) { var values = bag.Order().ToArray(); return values.Length == 0 ? null : values[(int)Math.Ceiling(values.Length * .95) - 1]; }
        var concurrentGates = new Dictionary<string, bool>
        {
            ["allEditsPublishedAndRefreshed"] = edits.Count == concurrentEdits,
            ["noQueryErrors"] = errors == 0,
            ["lexicalP95AtMost100Ms"] = P95(times[0]) <= 100,
            ["hybridP95AtMost500Ms"] = P95(times[1]) <= 500
        };
        concurrentPassed = concurrentGates.Values.All(value => value);
        concurrent = new { Basis = "Four readers alternate lexical/hybrid with stride-17 exact names while one writer edits, publishes and refreshes vectors; queries stop when the writer finishes. Mixed-mode phases are combined.",
            Edits = edits, Errors = errors, ErrorMessages = failures.ToArray(), Lexical = Summary(times[0]), Hybrid = Summary(times[1]),
            MinimumVectorCoveredSymbols = minimumCoverage == long.MaxValue ? (long?)null : minimumCoverage, QueryPhases = phases, Gates = concurrentGates };
    }
    using var process = Process.GetCurrentProcess(); process.Refresh();
    long? rss = process.PeakWorkingSet64 > 0 ? process.PeakWorkingSet64 : null;
    using var connection = database.Open(readOnly: true); using var command = connection.CreateCommand(); command.CommandText = "SELECT sqlite_version()";
    var gates = new Dictionary<string, bool?>
    {
        ["noQueryErrors"] = lexical.Errors == 0 && lexical.WarmupErrors == 0 && (hybrid is null || hybrid.Errors == 0 && hybrid.WarmupErrors == 0),
        ["lexicalP95AtMost100Ms"] = lexical.P95Ms <= 100,
        ["hybridP95AtMost500Ms"] = hybrid is null ? null : hybrid.P95Ms <= 500,
        ["retrievalOnlyP95TargetAtMost250Ms"] = hybrid?.QueryPhases?.Retrieval.P95Ms is double retrievalP95 ? retrievalP95 <= 250 : null,
        ["fiveThousandSymbolBodyEditAtMost2Seconds"] = symbols == 5000 ? editMs <= 2000 : null,
        ["fiveThousandSymbolSemanticRefreshAtMost10Seconds"] = symbols == 5000 && refreshMs.HasValue ? refreshMs <= 10000 : null,
        ["peakRssAtMost2GiB"] = rss.HasValue ? rss <= 2L * 1024 * 1024 * 1024 : null,
        ["concurrentEditWorkload"] = concurrentPassed
    };
    var report = new
    {
        Version = 1, ThresholdDefinitionVersion = 2, ReadMappingVersion = IndexDatabase.ReadMappingVersion, ReadPageCacheVersion = IndexDatabase.ReadPageCacheVersion, ReadPageCacheKiB = IndexDatabase.ReadPageCacheKiB, MaximumReadMappingBytes = IndexDatabase.MaximumReadMappingBytes, SearchCountCacheVersion = QueryService.SearchCountCacheVersion, SearchPlanVersion = QueryService.SearchPlanVersion, RankingProfile = QueryService.RankingProfile, LexicalWeight = QueryService.LexicalWeight, AliasWeight = QueryService.AliasWeight, VectorScorerVersion = ModelStore.VectorScorerVersion, VectorQueryPlanVersion = ModelStore.VectorQueryPlanVersion, StorageSchemaVersion = IndexDatabase.SchemaVersion, AdapterVersion = RoslynAnalyzer.AdapterVersion, OnnxInterOpThreads = 1, OnnxIntraOpThreads = Math.Clamp(Environment.ProcessorCount, 1, 4), TimestampUtc = DateTimeOffset.UtcNow, ExecutionMode = "Direct service API; owner/MCP transport excluded",
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
        NoOpIndexMs = noOpMs, BodyEditMs = editMs, VectorRefreshMs = refreshMs, EditToVectorsMs = refreshMs.HasValue ? editMs + refreshMs : (double?)null, ConcurrentEdits = concurrent, PeakRssBytes = rss, Gates = gates,
        Unmeasured = new[] { "owner/native IPC", "MCP/provider transport", "held-out relevance", "other platforms", "representative real repository", "edit p95 including watcher debounce", "owner admission queue and wire serialization latency" }.Concat(rss.HasValue ? Array.Empty<string>() : new[] { "peak RSS unavailable from this runtime" }).Concat(initial.Symbols < 50000 ? new[] { "50k-symbol capacity" } : fingerprint is null ? new[] { "50k-symbol hybrid capacity" } : Array.Empty<string>()).ToArray(),
        PassedMeasuredGates = gates.Values.All(value => value != false)
    };
    Directory.CreateDirectory(Path.GetDirectoryName(output)!);
    File.WriteAllText(output, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }) + "\n");
    Console.WriteLine(output); Console.WriteLine(JsonSerializer.Serialize(gates));
    if (retain == "true")
    {
        RetainedBenchmark.Save(temporary, indexer.Get(repository), names, sourceSymbols, fingerprint,
            report.CorpusHash, referenceHash);
        Console.Error.WriteLine("Retained synthetic fixture: " + temporary);
    }
    return report.PassedMeasuredGates ? 0 : 2;
}
finally { if (retain != "true" || !File.Exists(Path.Combine(temporary, "benchmark-fixture.praxis.json"))) Directory.Delete(temporary, recursive: true); }

internal sealed record Timing(int Readers, int Count, double P50Ms, double P95Ms, double MaximumMs, double P99Ms, int Errors, int WarmupErrors, string[] ErrorMessages, QueryPhaseSummary? QueryPhases = null);
internal sealed record QueryRun(int Run, Timing Lexical, Timing? Hybrid);
