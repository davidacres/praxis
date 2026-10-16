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

internal sealed record RetainedFixture(int Version, string RepositoryId, long Generation, long QueryEpoch,
    string[] Queries, int SourceSymbols, string? Fingerprint, string OriginalCorpusHash, string ReferenceHash,
    Dictionary<string, string> Files);

internal static class RetainedBenchmark
{
    private const string Marker = "benchmark-fixture.praxis.json";
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    internal static void Save(string directory, RepositoryRecord repository, List<string> queries, int sourceSymbols,
        string? fingerprint, string corpusHash, string referenceHash)
    {
        var files = Directory.EnumerateFiles(repository.Root).ToDictionary(path => Path.GetFileName(path)!,
            path => SourceFiles.Hash(File.ReadAllBytes(path)), StringComparer.Ordinal);
        var fixture = new RetainedFixture(1, repository.Id, repository.Generation, repository.QueryEpoch,
            queries.ToArray(), sourceSymbols, fingerprint, corpusHash, referenceHash,
            files);
        File.WriteAllText(Path.Combine(directory, Marker), JsonSerializer.Serialize(fixture, Json) + "\n");
    }

    internal static async Task<Timing> Measure(Action<string, int> search, string mode, int queries, int readers = 4, bool linearSchedule = false, QueryMetrics? metrics = null)
    {
        var messages = new ConcurrentQueue<string>(); int messageCount = 0, warmupErrors = 0, errors = 0;
        void Record(Exception error)
        {
            if (Interlocked.Increment(ref messageCount) <= 10) messages.Enqueue(error.GetType().Name + ": " + error.Message);
        }
        for (var i = 0; i < 20; i++)
            try { search(mode, i); }
            catch (Exception error) when (error is not OutOfMemoryException) { warmupErrors++; Record(error); }
        metrics?.Begin();
        var times = new ConcurrentBag<double>(); using var start = new Barrier(readers);
        await Task.WhenAll(Enumerable.Range(0, readers).Select(reader => Task.Run(() =>
        {
            start.SignalAndWait();
            for (var i = 0; i < queries; i++)
            {
                var timer = Stopwatch.StartNew();
                try { search(mode, linearSchedule ? (i * readers + reader) * 17 : i * 17 + reader); }
                catch (Exception error) when (error is not OutOfMemoryException) { Interlocked.Increment(ref errors); Record(error); }
                finally { times.Add(timer.Elapsed.TotalMilliseconds); }
            }
        })));
        var values = times.Order().ToArray();
        return new(readers, values.Length, values[(int)Math.Ceiling(values.Length * .5) - 1],
            values[(int)Math.Ceiling(values.Length * .95) - 1], values[^1],
            values[(int)Math.Ceiling(values.Length * .99) - 1], errors, warmupErrors, messages.ToArray(), metrics?.End());
    }

    internal static async Task<int> Run(string directory, int queries, string output, int readers, int runCount, string category = "exact")
    {
        directory = SourceFiles.CanonicalDirectory(directory);
        var marker = SourceFiles.Resolve(directory, Marker);
        if (new FileInfo(marker).Length > 8 * 1024 * 1024) throw new IOException("Fixture metadata exceeds 8 MiB.");
        var fixture = JsonSerializer.Deserialize<RetainedFixture>(File.ReadAllText(marker))
            ?? throw new IOException("Missing retained fixture metadata.");
        if (fixture.Version != 1 || fixture.Queries is not { Length: >= 1 and <= 50_000 }
            || fixture.Files is not { Count: >= 1 and <= 1001 } || fixture.SourceSymbols is < 100 or > 49_999)
            throw new IOException("Unsupported retained synthetic fixture.");
        if (fixture.Queries.Any(query => string.IsNullOrWhiteSpace(query) || query.Length > 2000))
            throw new IOException("Invalid retained queries.");
        var root = SourceFiles.CanonicalDirectory(Path.Combine(directory, "source"));
        if (Directory.EnumerateDirectories(root).Any() || Directory.EnumerateFiles(root).Count() != fixture.Files.Count)
            throw new IOException("Retained source membership changed.");
        foreach (var file in fixture.Files)
            if (SourceFiles.Read(root, file.Key, CancellationToken.None).Hash != file.Value)
                throw new IOException("Retained source bytes changed: " + file.Key);
        var snapshotHash = SourceFiles.Hash(Encoding.UTF8.GetBytes(string.Join('\n', fixture.Files
            .OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => pair.Key + ":" + pair.Value))));
        var database = new IndexDatabase(Path.Combine(directory, "data", "index.db"));
        var indexer = new RepositoryIndexer(database); var repository = indexer.Get(fixture.RepositoryId);
        if (repository.Root != root || repository.Generation != fixture.Generation || repository.QueryEpoch != fixture.QueryEpoch
            || repository.State != "ready") throw new IOException("Retained index snapshot changed.");
        using var models = new ModelStore(database, Path.Combine(directory, "models"));
        using (var read = database.Open(readOnly: true))
        using (var check = read.CreateCommand())
        {
            check.CommandText = "SELECT model_fingerprint FROM repository_models WHERE repository_id=$id AND state='active'";
            check.Parameters.AddWithValue("$id", repository.Id);
            if (check.ExecuteScalar() as string != fixture.Fingerprint) throw new IOException("Retained active model changed.");
        }
        string Query(int index) => category switch {
            "terminology" => "authentication token category " + (index % 16),
            "behaviour" => "parse input value category " + (index % 16),
            "negative" => "satellite orbit weather " + index,
            _ => fixture.Queries[index % fixture.Queries.Length]
        };
        var metrics = new QueryMetrics(); var service = new QueryService(database, models) { MeasurementObserver = metrics.Record }; var allowed = new HashSet<string> { repository.Id };
        void Search(string mode, int index)
        {
            var response = service.Execute("search_code", new JsonObject { ["repositoryId"] = repository.Id,
                ["query"] = Query(index), ["mode"] = mode,
                ["limit"] = 10, ["responseBudgetTokens"] = 8000 }, allowed);
            if (response["error"] is not null || response["data"]?["matches"] is not JsonArray matches
                || category == "exact" && matches.Count == 0
                || response["indexGeneration"]?.GetValue<long>() != fixture.Generation
                || response["queryEpoch"]?.GetValue<long>() != fixture.QueryEpoch)
                throw new IOException("Retained query failed or changed snapshot: " + response.ToJsonString());
            if (mode == "hybrid" && (response["data"]?["channelsUsed"] is not JsonArray channels
                || !channels.Any(channel => channel?.GetValue<string>() == "vector")
                || response["data"]?["eligibleSymbolCount"]?.GetValue<long>() != fixture.SourceSymbols
                || response["data"]?["vectorCoveredSymbolCount"]?.GetValue<long>() != fixture.SourceSymbols))
                throw new IOException("Retained hybrid query requires complete current vector coverage.");
        }
        var samples = new List<QueryRun>(); var linearSchedule = true;
        for (var run = 1; run <= runCount; run++)
        {
            Console.Error.WriteLine($"Measuring retained {readers}-reader lexical queries, run {run}/{runCount}.");
            var lexicalRun = await Measure(Search, "lexical", queries, readers, linearSchedule, metrics);
            Timing? hybridRun = null;
            if (fixture.Fingerprint is not null)
            {
                Console.Error.WriteLine($"Measuring retained {readers}-reader hybrid queries, run {run}/{runCount}.");
                hybridRun = await Measure(Search, "hybrid", queries, readers, linearSchedule, metrics);
            }
            samples.Add(new(run, lexicalRun, hybridRun));
        }
        var lexical = samples.OrderByDescending(sample => sample.Lexical.P95Ms).First().Lexical;
        var hybrid = samples.Where(sample => sample.Hybrid is not null).Select(sample => sample.Hybrid!)
            .OrderByDescending(sample => sample.P95Ms).FirstOrDefault();
        double? embeddingMs = null, candidateScanMs = null;
        if (fixture.Fingerprint is not null)
        {
            var timer = Stopwatch.StartNew();
            var vector = models.QueryEmbedding(repository.Id, fixture.Queries[0], CancellationToken.None)!;
            embeddingMs = timer.Elapsed.TotalMilliseconds;
            using var read = database.Open(readOnly: true); using var snapshot = read.BeginTransaction(deferred: true);
            timer.Restart();
            var candidates = ModelStore.Candidates(read, snapshot, repository.Id, vector, null, null, null);
            candidateScanMs = timer.Elapsed.TotalMilliseconds;
            if (candidates.Count == 0) throw new IOException("Diagnostic scan returned no candidates.");
        }
        var after = indexer.Get(repository.Id);
        if (after.Generation != repository.Generation || after.QueryEpoch != repository.QueryEpoch || after.Root != repository.Root
            || after.State != repository.State) throw new IOException("Retained index changed during measurements.");
        using var connection = database.Open(readOnly: true);
        object? Scalar(string sql) { using var command = connection.CreateCommand(); command.CommandText = sql; return command.ExecuteScalar(); }
        var retrievalP95 = samples.Select(sample => sample.Hybrid?.QueryPhases?.Retrieval.P95Ms).Max();
        var gates = new Dictionary<string, bool?> {
            ["noQueryErrors"] = samples.All(sample => sample.Lexical.Errors == 0 && sample.Lexical.WarmupErrors == 0
                && (sample.Hybrid is null || sample.Hybrid.Errors == 0 && sample.Hybrid.WarmupErrors == 0)),
            ["lexicalP95AtMost100Ms"] = lexical.P95Ms <= 100,
            ["hybridP95AtMost500Ms"] = hybrid is null ? null : hybrid.P95Ms <= 500,
            ["retrievalOnlyP95TargetAtMost250Ms"] = retrievalP95 is double retrievalMs ? retrievalMs <= 250 : null };
        var report = new { Version = 2, ExecutionMode = "Retained post-edit synthetic snapshot; query-only, direct service API",
            Readers = readers, RunCount = runCount, WarmupsPerRun = 20, QueriesPerReader = queries, QueryCategory = category,
            QueryScheduleVersion = linearSchedule ? 2 : 1, QueryStride = 17,
            QuerySetHash = SourceFiles.Hash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(Enumerable.Range(0, queries * readers).Select(index => Query(index * 17))))),
            Measurements = samples, SummaryBasis = "Top-level timing is the run with highest p95; all runs and failures retained",
            P95Range = new { LexicalMin = samples.Min(sample => sample.Lexical.P95Ms), LexicalMax = lexical.P95Ms,
                HybridMin = samples.Where(sample => sample.Hybrid is not null).Select(sample => (double?)sample.Hybrid!.P95Ms).Min(),
                HybridMax = hybrid?.P95Ms },
            LogicalProcessors = Environment.ProcessorCount, OnnxInterOpThreads = 1, OnnxIntraOpThreads = Math.Clamp(Environment.ProcessorCount, 1, 4),
            TimestampUtc = DateTimeOffset.UtcNow, Runtime = RuntimeInformation.FrameworkDescription,
            OperatingSystem = RuntimeInformation.OSDescription, Architecture = RuntimeInformation.ProcessArchitecture.ToString(),
            Sqlite = Scalar("SELECT sqlite_version()"), ActualReadMappingBytes = Scalar("PRAGMA mmap_size"), ActualReadPageCacheSetting = Scalar("PRAGMA cache_size"),
            IndexDatabase.ReadMappingVersion, IndexDatabase.MaximumReadMappingBytes,
            IndexDatabase.ReadPageCacheVersion, IndexDatabase.ReadPageCacheKiB, QueryService.SearchPlanVersion, QueryService.RankingProfile, QueryService.LexicalWeight, QueryService.AliasWeight,
            QueryService.SearchCountCacheVersion, ModelStore.VectorScorerVersion, ModelStore.VectorQueryPlanVersion,
            fixture.SourceSymbols, fixture.OriginalCorpusHash, SnapshotHash = snapshotHash, fixture.ReferenceHash,
            ModelFingerprint = fixture.Fingerprint, fixture.Generation, fixture.QueryEpoch, Lexical = lexical, Hybrid = hybrid,
            DiagnosticSample = new { Basis = "One warmed single-reader observation after timed queries; not latency percentiles",
                QueryEmbeddingMs = embeddingMs, ExactCandidateScanMs = candidateScanMs },
            Gates = gates, PassedMeasuredGates = gates.Values.All(value => value != false),
            Unmeasured = new[] { "cold startup/index/embedding", "edit publication/refresh", "peak RSS from runtime",
                "owner/MCP/provider transport", "held-out relevance", "other reader counts/query categories/concurrent edits; this report covers only its declared category" } };
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        File.WriteAllText(output, JsonSerializer.Serialize(report, Json) + "\n");
        Console.WriteLine(output); Console.WriteLine(JsonSerializer.Serialize(gates));
        return report.PassedMeasuredGates ? 0 : 2;
    }
}
