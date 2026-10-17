using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Embeddings;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;
using Praxis.CodeIntelligence.Host;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class LocalModelFactAttribute : FactAttribute
{
    public LocalModelFactAttribute() { if (Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE") is null) Skip = "Provisioned model bundle is required for native model verification."; }
}

public sealed class LocalModelTheoryAttribute : TheoryAttribute
{
    public LocalModelTheoryAttribute() { if (Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE") is null) Skip = "Provisioned model bundle is required for native model verification."; }
}
public sealed class ModelTests
{
    [LocalModelFact]
    public void LowDiskActivationPreservesTheUsableProfileAndPublishedVectors()
    {
        var root = Path.Combine(Path.GetTempPath(), "pci-low-disk-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize();
            File.WriteAllText(Path.Combine(root, "Example.cs"), "class Example { int Preserve() => 1; }");
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root); indexer.Index(repository);
            using var store = new ModelStore(database, Path.Combine(root, "models"));
            var profile = store.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!);
            store.Activate(repository, profile, CancellationToken.None);
            var queries = new QueryService(database, store);
            JsonObject Search() => queries.Execute("search_code", new() { ["repositoryId"] = repository, ["query"] = "Preserve", ["mode"] = "vector" }, new HashSet<string> { repository });
            var before = Search(); Assert.Null(before["error"]);
            // Never create a low-space host condition: fail the volume preflight
            // deterministically while exercising actual model/SQLite state.
            string? checkedVolume = null;
            store.AvailableDiskBytes = path => { checkedVolume = path; return 0; };
            Assert.Contains("INSUFFICIENT_DISK_SPACE", Assert.Throws<IOException>(() => store.Activate(repository, profile, CancellationToken.None)).Message);
            Assert.Equal(Path.GetDirectoryName(database.Path), checkedVolume);
            var after = Search(); Assert.Null(after["error"]);
            Assert.Equal(before["queryEpoch"]!.GetValue<long>(), after["queryEpoch"]!.GetValue<long>());
            Assert.Equal(before["data"]!.ToJsonString(), after["data"]!.ToJsonString());
            Assert.Empty(database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [LocalModelFact]
    public void VectorCapacityReturnsHonestHybridFallbackAndExplicitRequiredVectorError()
    {
        var root = Path.Combine(Path.GetTempPath(), "pci-vector-capacity-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize();
            File.WriteAllText(Path.Combine(root, "Example.cs"), "class Example { int Preserve() => 1; }");
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root); indexer.Index(repository);
            using var store = new ModelStore(database, Path.Combine(root, "models"));
            var profile = store.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!); store.Activate(repository, profile, CancellationToken.None);
            var queries = new QueryService(database, store) { VectorChunkLimit = 1 };
            JsonObject Search(string mode) => queries.Execute("search_code", new() { ["repositoryId"] = repository, ["query"] = "Preserve", ["mode"] = mode }, new HashSet<string> { repository });
            var hybrid = Search("hybrid"); Assert.Null(hybrid["error"]);
            Assert.NotEmpty(hybrid["data"]!["matches"]!.AsArray());
            Assert.DoesNotContain(hybrid["data"]!["channelsUsed"]!.AsArray(), channel => channel!.GetValue<string>() == "vector");
            Assert.Equal(0, hybrid["data"]!["vectorCoveredSymbolCount"]!.GetValue<long>());
            Assert.Contains(hybrid["warnings"]!.AsArray(), warning => warning!["code"]!.GetValue<string>() == "VECTOR_CAPACITY_EXCEEDED");
            Assert.Equal("VECTOR_CAPACITY_EXCEEDED", Search("vector")["error"]!["code"]!.GetValue<string>());
            Assert.Null(Search("lexical")["error"]); Assert.Empty(database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public void RepresentationPrioritizesIdentityAndRecordsBoundedSourceCoordinates()
    {
        const string sourceText = "prefix class Example { string Value => \"😀\"; } suffix";
        var bytes = System.Text.Encoding.UTF8.GetBytes(sourceText);
        var source = new SourceInput("Example.cs", SourceFiles.Hash(bytes), bytes, sourceText);
        var representation = RepresentationBuilder.Build("Example", "class Example", "documentation", "baseline", source, 7, sourceText.Length - 7);
        var span = Assert.Single(representation.Sources);
        Assert.Equal(sourceText[span.Start..span.End], representation.Text[span.RepresentationStart..span.RepresentationEnd]);
        Assert.StartsWith("Example\nclass Example\ndocumentation\nbaseline", representation.Text);
        Assert.Equal(SourceFiles.Hash(System.Text.Encoding.UTF8.GetBytes(representation.Text)), representation.Hash);
        var limited = RepresentationBuilder.Build("Example", "class Example", new string('x', 20000), "baseline", source, 7, sourceText.Length - 7);
        Assert.True(limited.Truncated); Assert.InRange(limited.Text.Length, 1, 16384); Assert.Empty(limited.Sources);
    }

    [Fact]
    public void BertSpecialTokensBypassNormalizationAndKeepTheirVocabularyIds()
    {
        var tokenizer = new WordPieceTokenizer(["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", "hello"]);
        Assert.Equal(new long[] { 2, 2, 5, 3, 1, 0, 4, 3 }, tokenizer.EncodeChunks("[CLS]HÉLLO[SEP] [UNK] [PAD] [MASK]")[0]);
    }

    [LocalModelFact]
    public void BaselineMatchesIndependentPythonTokenizerAndOnnxGolden()
    {
        var fixture = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "bge-small-golden.json")))!;
        var bundle = Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!;
        var tokenizer = new WordPieceTokenizer(File.ReadLines(Path.Combine(bundle, "vocab.txt")));
        using var model = new LocalModel(bundle);
        foreach (var item in fixture["cases"]!.AsArray())
        {
            var text = item!["text"]!.GetValue<string>(); var actual = tokenizer.EncodeChunks(text);
            var expected = item["tokenChunks"]!.AsArray();
            var detailed = tokenizer.EncodeDetailed(text);
            for (var chunk = 0; chunk < detailed.Count; chunk++)
            {
                var span = item["chunkSpans"]![chunk]!;
                Assert.Equal(span["start"]!.GetValue<int>(), detailed[chunk].Start);
                Assert.Equal(span["end"]!.GetValue<int>(), detailed[chunk].End);
                Assert.Equal(span["firstToken"]!.GetValue<int>(), detailed[chunk].FirstToken);
                Assert.Equal(span["endToken"]!.GetValue<int>(), detailed[chunk].EndToken);
                Assert.Equal(span["truncated"]!.GetValue<bool>(), detailed[chunk].Truncated);
            }
            Assert.Equal(expected.Count, actual.Count);
            for (var chunk = 0; chunk < actual.Count; chunk++)
                Assert.Equal(expected[chunk]!.AsArray().Select(id => id!.GetValue<long>()), actual[chunk]);
            if (item["queryVector"] is not JsonArray vector) continue;
            var result = model.EmbedQuery(text, CancellationToken.None); LocalModel.ValidateVector(result);
            double cosine = 0;
            for (var dimension = 0; dimension < result.Length; dimension++)
            {
                var reference = vector[dimension]!.GetValue<double>();
                Assert.InRange(Math.Abs(result[dimension] - reference), 0, fixture["absoluteTolerance"]!.GetValue<double>());
                cosine += result[dimension] * reference;
            }
            Assert.True(cosine >= fixture["minimumCosine"]!.GetValue<double>(), "Golden cosine below tolerance: " + cosine);
        }
    }

    [LocalModelFact]
    public async Task RuntimeRefreshesVectorsFromDurableWorkAfterSourcePublication()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-refresh-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(Path.Combine(root, "Example.cs"), "class AuthenticationTokenParser { string ParseToken(string token) => token; }");
            using var runtime = new ServiceRuntime(Path.Combine(root, "runtime"));
            var id = runtime.Dispatch(new JsonObject { ["action"] = "register", ["root"] = root }, CancellationToken.None)["data"]!["repositoryId"]!.GetValue<string>();
            Assert.Null(runtime.Dispatch(new JsonObject { ["action"] = "index", ["repositoryId"] = id }, CancellationToken.None)["error"]);
            var installed = runtime.Dispatch(new JsonObject { ["action"] = "model-install", ["bundle"] = Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE") }, CancellationToken.None);
            var fingerprint = installed["data"]!["fingerprint"]!.GetValue<string>();
            var queued = runtime.Dispatch(new JsonObject { ["action"] = "model-activate", ["repositoryId"] = id, ["fingerprint"] = fingerprint }, CancellationToken.None);
            Assert.True(queued["data"]!["queued"]!.GetValue<bool>());
            JsonObject Search() => runtime.Dispatch(new JsonObject { ["action"] = "query", ["tool"] = "search_code", ["arguments"] = new JsonObject { ["repositoryId"] = id, ["query"] = "token parser", ["mode"] = "vector", ["filters"] = new JsonObject { ["kinds"] = new JsonArray("method") }, ["responseBudgetTokens"] = 8000 } }, CancellationToken.None);
            async Task WaitForVectors()
            {
                // Watcher debounce can insert an additional reconciliation before
                // embedding. Assert eventual publication, not an exact tick count.
                var elapsed = System.Diagnostics.Stopwatch.StartNew();
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                JsonObject? result = null;
                while (elapsed.Elapsed < TimeSpan.FromSeconds(10))
                {
                    await runtime.MaintainAsync(timeout.Token);
                    result = Search();
                    if (result["error"] is null && result["data"]?["matches"] is JsonArray { Count: > 0 }) return;
                    if (result["error"] is not null) Assert.Equal("MODEL_UNAVAILABLE", result["error"]!["code"]!.GetValue<string>());
                    await Task.Delay(25);
                }
                Assert.Fail("Durable vector publication did not complete: " + result?.ToJsonString());
            }
            await WaitForVectors();
            File.WriteAllText(Path.Combine(root, "Example.cs"), File.ReadAllText(Path.Combine(root, "Example.cs")).Replace("=> token;", "=> token.Trim();"));
            Assert.Null(runtime.Dispatch(new JsonObject { ["action"] = "index", ["repositoryId"] = id }, CancellationToken.None)["error"]);
            Assert.Empty(Search()["data"]!["matches"]!.AsArray());
            await WaitForVectors();
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    // The desktop activates the installed model for a repository it has just registered,
    // and for one whose index is still failing; both used to be refused ("Index must be
    // ready"), the refusal was dropped, and vector search stayed MODEL_UNAVAILABLE for ever.
    [LocalModelTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActivationBeforeTheIndexIsReadyIsHonouredOnceItIs(bool previouslyPublished)
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-deferred-activation-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(Path.Combine(root, "Example.cs"), "class AuthenticationTokenParser { string ParseToken(string token) => token; }");
            using var runtime = new ServiceRuntime(Path.Combine(root, "runtime"));
            var id = runtime.Dispatch(new JsonObject { ["action"] = "register", ["root"] = root }, CancellationToken.None)["data"]!["repositoryId"]!.GetValue<string>();
            // Install first: installing a model makes the next index republish, which would
            // queue vectors itself and hide the unchanged-reconciliation case.
            var fingerprint = runtime.Dispatch(new JsonObject { ["action"] = "model-install", ["bundle"] = Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE") }, CancellationToken.None)["data"]!["fingerprint"]!.GetValue<string>();
            if (previouslyPublished)
            {
                // A published index the owner no longer reports ready: its next
                // reconciliation finds nothing changed and publishes nothing.
                Assert.Null(runtime.Dispatch(new JsonObject { ["action"] = "index", ["repositoryId"] = id }, CancellationToken.None)["error"]);
                using var connection = runtime.Database.Open();
                connection.Execute(null, "UPDATE repositories SET state='unknown' WHERE repository_id=$0", id);
            }
            var activated = runtime.Dispatch(new JsonObject { ["action"] = "model-activate", ["repositoryId"] = id, ["fingerprint"] = fingerprint }, CancellationToken.None);
            Assert.Null(activated["error"]);
            Assert.True(activated["data"]!["queued"]!.GetValue<bool>());
            if (previouslyPublished)
            {
                var reconciled = runtime.Dispatch(new JsonObject { ["action"] = "index", ["repositoryId"] = id }, CancellationToken.None);
                Assert.Null(reconciled["error"]);
                Assert.False(reconciled["data"]!["changed"]!.GetValue<bool>()); // nothing republished, so nothing else queues vectors
            }
            var elapsed = System.Diagnostics.Stopwatch.StartNew(); JsonObject? result = null;
            while (elapsed.Elapsed < TimeSpan.FromSeconds(20))
            {
                await runtime.MaintainAsync(CancellationToken.None);
                result = runtime.Dispatch(new JsonObject { ["action"] = "query", ["tool"] = "search_code", ["arguments"] = new JsonObject { ["repositoryId"] = id, ["query"] = "token parser", ["mode"] = "vector", ["responseBudgetTokens"] = 8000 } }, CancellationToken.None);
                if (result["error"] is null && result["data"]?["matches"] is JsonArray { Count: > 0 }) return;
                await Task.Delay(25);
            }
            Assert.Fail("Deferred activation never produced vectors: " + result?.ToJsonString());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public void WordPieceUsesUncasedAccentStrippingAndCompleteBoundedChunks()
    {
        var tokenizer = new WordPieceTokenizer(["[PAD]", "[UNK]", "[CLS]", "[SEP]", "hello", "world", "##s", ","]);
        Assert.Equal(new long[] { 2, 4, 7, 5, 6, 3 }, tokenizer.EncodeChunks("Héllo, worlds")[0]);
        var chunks = tokenizer.EncodeChunks(string.Join(' ', Enumerable.Repeat("hello", 50)), maximumTokens: 8, maximumChunks: 4);
        Assert.Equal(4, chunks.Count); Assert.All(chunks, chunk => Assert.Equal(8, chunk.Length));
        Assert.Equal(new long[] { 2, 1, 3 }, tokenizer.EncodeChunks("missing")[0]);
    }

    [LocalModelFact]
    public void CurrentVectorsAreNotRewrittenButCorruptSourceMetadataIsRepaired()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-current-vectors-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize();
            File.WriteAllText(Path.Combine(root, "Example.cs"), "class Example { int Run() => 1; }");
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root); indexer.Index(repository);
            using var store = new ModelStore(database, Path.Combine(root, "models"));
            var profile = store.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!); store.Activate(repository, profile, CancellationToken.None);
            var query = store.QueryEmbedding(repository, "Example Run", CancellationToken.None)!;
            IReadOnlyList<VectorCandidate> ranked;
            using (var read = database.Open(readOnly: true))
            using (var transaction = read.BeginTransaction(deferred: true))
            {
                var actual = ModelStore.Candidates(read, transaction, repository, query, null, null, null);
                ranked = actual;
                var expected = new Dictionary<string, double>();
                using (var command = read.CreateCommand())
                {
                    command.Transaction = transaction; command.CommandText = "SELECT e.symbol_id,v.values_blob FROM vectors v JOIN embedding_sets e ON e.set_id=v.set_id";
                    using var reader = command.ExecuteReader();
                    while (reader.Read())
                    {
                        var bytes = (byte[])reader.GetValue(1); double dot = 0;
                        for (var i = 0; i < 384; i++) dot += System.Buffers.Binary.BinaryPrimitives.ReadSingleLittleEndian(bytes.AsSpan(i * 4, 4)) * query.Vector[i];
                        var id = reader.GetString(0); expected[id] = expected.TryGetValue(id, out var prior) ? Math.Max(prior, dot) : dot;
                    }
                }
                Assert.Equal(expected.Count, actual.Count);
                foreach (var candidate in actual) Assert.Equal(expected[candidate.SymbolId], candidate.Score, 12);
                using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
                Assert.Throws<OperationCanceledException>(() => ModelStore.Candidates(read, transaction, repository, query, null, null, null, cancelled.Token));
            }
            var response = new QueryService(database, store).Execute("search_code", new JsonObject
            { ["repositoryId"] = repository, ["query"] = "Example Run", ["mode"] = "vector", ["responseBudgetTokens"] = 8000 },
                new HashSet<string> { repository });
            Assert.Null(response["error"]);
            var matches = response["data"]!["matches"]!.AsArray();
            Assert.Equal(ranked.Select(candidate => candidate.SymbolId), matches.Select(match => match!["symbol"]!["symbolId"]!.GetValue<string>()));
            Assert.Equal(Enumerable.Range(1, ranked.Count), matches.Select(match => match!["ranks"]!["vector"]!.GetValue<int>()));
            using (var write = database.Open())
            using (var command = write.CreateCommand())
            {
                command.CommandText = "CREATE TRIGGER forbid_rewrite BEFORE DELETE ON embedding_sets BEGIN SELECT RAISE(ABORT,'unchanged vector rewrite'); END";
                command.ExecuteNonQuery();
            }
            store.Activate(repository, profile, CancellationToken.None);
            using (var write = database.Open())
            using (var command = write.CreateCommand())
            {
                command.CommandText = "DROP TRIGGER forbid_rewrite; UPDATE embedding_sets SET state='stale'; UPDATE vectors SET spans_json=json_set(spans_json,'$.Sources[0].ContentHash','corrupt') WHERE json_array_length(spans_json,'$.Sources')>0; UPDATE embedding_sets SET state='ready'";
                command.ExecuteNonQuery();
            }
            store.Activate(repository, profile, CancellationToken.None);
            using (var read = database.Open(readOnly: true))
            using (var command = read.CreateCommand())
            {
                command.CommandText = "SELECT count(*) FROM vectors WHERE json_extract(spans_json,'$.Sources[0].ContentHash')='corrupt'";
                Assert.Equal(0L, command.ExecuteScalar());
            }
            Assert.Empty(database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private sealed class FixedVectorBackend(Func<IReadOnlyList<VectorCandidate>> ranked) : IVectorBackend
    {
        public string BackendName => "fixed-test";
        public IReadOnlyList<VectorCandidate> FindCandidates(Microsoft.Data.Sqlite.SqliteConnection connection, Microsoft.Data.Sqlite.SqliteTransaction transaction,
            string repositoryId, ModelQuery query, VectorSearchFilter filter, CancellationToken cancellationToken = default) => ranked();
    }

    [LocalModelFact]
    public void TheBestVectorCandidateIsKeptOnTheFirstPageAndPagingStaysComplete()
    {
        // Twelve keyword matches would otherwise fill the first page; the model's best
        // candidate (a paraphrase match with no keyword hit) must still reach place 10.
        var root = Path.Combine(Path.GetTempPath(), "praxis-vector-floor-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            for (var i = 0; i < 12; i++) File.WriteAllText(Path.Combine(root, $"Widget{i}.cs"), $"class Widget{i} {{ void Render() {{}} }}");
            File.WriteAllText(Path.Combine(root, "Painter.cs"), "class Painter { void Draw() {} }");
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize();
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root); indexer.Index(repository);
            using var store = new ModelStore(database, Path.Combine(root, "models"));
            store.Activate(repository, store.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!), CancellationToken.None);
            string Id(string name) { using var c = database.Open(readOnly: true); return (string)c.Scalar(null, "SELECT symbol_id FROM symbols WHERE name=$0", name)!; }
            var draw = Id("Draw");
            store.VectorBackend = new FixedVectorBackend(() => [new VectorCandidate(draw, 0.9)]);
            var queries = new QueryService(database, store);
            JsonObject Page(string? cursor)
            {
                var arguments = new JsonObject { ["repositoryId"] = repository, ["query"] = "render", ["mode"] = "hybrid", ["limit"] = 10, ["responseBudgetTokens"] = 8000 };
                if (cursor is not null) arguments["cursor"] = cursor;
                return queries.Execute("search_code", arguments, new HashSet<string> { repository });
            }
            var first = Page(null); Assert.Null(first["error"]);
            var firstIds = first["data"]!["matches"]!.AsArray().Select(m => m!["symbol"]!["symbolId"]!.GetValue<string>()).ToList();
            Assert.Equal(10, firstIds.Count);
            Assert.Equal(draw, firstIds[9]);
            var all = new List<string>(firstIds);
            for (var cursor = first["nextCursor"]?.GetValue<string>(); cursor is not null;)
            {
                var next = Page(cursor); Assert.Null(next["error"]);
                all.AddRange(next["data"]!["matches"]!.AsArray().Select(m => m!["symbol"]!["symbolId"]!.GetValue<string>()));
                cursor = next["nextCursor"]?.GetValue<string>();
            }
            Assert.Equal(all.Count, all.Distinct().Count());
            Assert.Contains(draw, all);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [LocalModelFact]
    public void AnInterruptedBuildKeepsCommittedBatchesWithoutActivatingAndTheRetryFinishes()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-vector-batches-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            for (var i = 0; i < 4; i++) File.WriteAllText(Path.Combine(root, $"Part{i}.cs"), $"class Part{i} {{ int Measure() => {i}; }}");
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize();
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root); indexer.Index(repository);
            using var store = new ModelStore(database, Path.Combine(root, "models")) { VectorCommitBatchSize = 2 };
            var profile = store.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!);
            long Scalar(string sql) { using var c = database.Open(readOnly: true); return Convert.ToInt64(c.Scalar(null, sql, repository) ?? 0L); }
            var eligible = Scalar("SELECT count(*) FROM symbols WHERE repository_id=$0 AND external=0");
            Assert.True(eligible > 4);
            using var cancellation = new CancellationTokenSource();
            var batches = new List<int>();
            store.BatchCommitted = committed => { batches.Add(committed); cancellation.Cancel(); };
            Assert.ThrowsAny<OperationCanceledException>(() => store.Activate(repository, profile, cancellation.Token));
            // The first batch is durable, but the profile is not active, so search ignores it.
            Assert.Equal(new[] { 2 }, batches);
            Assert.Equal(2L, Scalar("SELECT count(*) FROM embedding_sets e JOIN symbols s ON s.symbol_id=e.symbol_id WHERE s.repository_id=$0 AND e.state='ready'"));
            Assert.Equal(0L, Scalar("SELECT count(*) FROM repository_models WHERE repository_id=$0 AND state='active'"));
            Assert.Null(store.QueryEmbedding(repository, "measure a part", CancellationToken.None));
            // The retry reuses the committed sets and embeds only the rest.
            batches.Clear(); store.BatchCommitted = batches.Add;
            store.Activate(repository, profile, CancellationToken.None);
            Assert.Equal(eligible - 2, batches[^1]);
            Assert.Equal(eligible, Scalar("SELECT count(*) FROM embedding_sets e JOIN symbols s ON s.symbol_id=e.symbol_id WHERE s.repository_id=$0 AND e.state='ready'"));
            Assert.Equal(1L, Scalar("SELECT count(*) FROM repository_models WHERE repository_id=$0 AND state='active'"));
            Assert.NotNull(store.QueryEmbedding(repository, "measure a part", CancellationToken.None));
            Assert.Empty(database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [LocalModelFact]
    public void QueriesAndVectorRefreshesShareOneInferenceSession()
    {
        // Each session holds the whole model (about 130 MB native plus its load buffers); loading
        // one per refresh is what pushed the 50k concurrent-edit run to within 26 MiB of 2 GiB.
        var root = Path.Combine(Path.GetTempPath(), "praxis-shared-session-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize();
            File.WriteAllText(Path.Combine(root, "Parser.cs"), "class TokenParser { string Parse(string token) => token; }");
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root); indexer.Index(repository);
            using var store = new ModelStore(database, Path.Combine(root, "models"));
            var profile = store.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!);
            Assert.Equal(0, store.SessionsCreated);
            store.Activate(repository, profile, CancellationToken.None);
            var queries = new QueryService(database, store);
            JsonObject Search() => queries.Execute("search_code", new JsonObject { ["repositoryId"] = repository, ["query"] = "parse a token", ["mode"] = "vector" }, new HashSet<string> { repository });
            Assert.Null(Search()["error"]);
            File.WriteAllText(Path.Combine(root, "Parser.cs"), "class TokenParser { string Parse(string token) => token.Trim(); }");
            Assert.True(indexer.Index(repository).Changed);
            store.Activate(repository, profile, CancellationToken.None);
            var refreshed = Search(); Assert.Null(refreshed["error"]);
            Assert.Equal(refreshed["data"]!["eligibleSymbolCount"]!.GetValue<long>(), refreshed["data"]!["vectorCoveredSymbolCount"]!.GetValue<long>());
            Assert.Equal(1, store.SessionsCreated);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [LocalModelFact]
    public void ProfileVerificationChecksAssetHashesWithoutASession()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-verify-profile-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var bundle = Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!;
            foreach (var name in new[] { "manifest.json", "model.onnx", "vocab.txt" }) File.Copy(Path.Combine(bundle, name), Path.Combine(root, name));
            using (var model = new LocalModel(bundle)) Assert.Equal(model.Fingerprint, LocalModel.VerifyFingerprint(root));
            using (var stream = File.OpenWrite(Path.Combine(root, "model.onnx"))) { stream.Seek(-1, SeekOrigin.End); stream.WriteByte(0x5A); }
            Assert.Contains("checksum", Assert.Throws<IOException>(() => LocalModel.VerifyFingerprint(root)).Message);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [LocalModelFact]
    public void BodyEditsRetainUnchangedVectorBlobsAndRevokeChangedRepresentations()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-retained-vectors-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize();
            File.WriteAllText(Path.Combine(root, "Changed.cs"), "class Changed { int Run() => 1; }");
            File.WriteAllText(Path.Combine(root, "Unchanged.cs"), "class Unchanged { int Keep() => 2; }");
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root); indexer.Index(repository);
            using var store = new ModelStore(database, Path.Combine(root, "models"));
            var profile = store.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!); store.Activate(repository, profile, CancellationToken.None);
            var queries = new QueryService(database, store);
            JsonObject Search() => queries.Execute("search_code", new JsonObject { ["repositoryId"] = repository, ["query"] = "Keep Run", ["mode"] = "vector" }, new HashSet<string> { repository });
            var before = Search(); Assert.Null(before["error"]);
            Assert.Equal(before["data"]!["eligibleSymbolCount"]!.GetValue<long>(), before["data"]!["vectorCoveredSymbolCount"]!.GetValue<long>());
            using (var connection = database.Open())
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "CREATE TRIGGER preserve_blob_delete BEFORE DELETE ON vectors WHEN OLD.set_id IN(SELECT e.set_id FROM embedding_sets e JOIN symbols s ON s.symbol_id=e.symbol_id WHERE s.name='Keep') BEGIN SELECT RAISE(ABORT,'unchanged vector deleted'); END; "
                    + "CREATE TRIGGER preserve_blob_update BEFORE UPDATE OF values_blob ON vectors BEGIN SELECT RAISE(ABORT,'vector blob rewritten'); END";
                command.ExecuteNonQuery();
            }
            File.WriteAllText(Path.Combine(root, "Changed.cs"), "class Changed { int Run() => 3; }");
            Assert.True(indexer.Index(repository).Changed);
            var stale = Search(); Assert.Null(stale["error"]);
            Assert.True(stale["data"]!["vectorCoveredSymbolCount"]!.GetValue<long>() < stale["data"]!["eligibleSymbolCount"]!.GetValue<long>());
            using (var connection = database.Open(readOnly: true))
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT count(*) FROM embedding_sets e JOIN symbols s ON s.symbol_id=e.symbol_id WHERE s.name='Keep' AND e.state='ready' AND e.input_revision=s.revision";
                Assert.Equal(1L, command.ExecuteScalar());
                command.CommandText = "SELECT count(*) FROM embedding_sets e JOIN symbols s ON s.symbol_id=e.symbol_id WHERE s.name='Run'";
                Assert.Equal(0L, command.ExecuteScalar());
                command.CommandText = "SELECT count(*) FROM jobs WHERE kind='embed' AND state='pending'";
                Assert.Equal(1L, command.ExecuteScalar());
            }
            store.Activate(repository, profile, CancellationToken.None);
            var refreshed = Search(); Assert.Null(refreshed["error"]);
            Assert.Equal(refreshed["data"]!["eligibleSymbolCount"]!.GetValue<long>(), refreshed["data"]!["vectorCoveredSymbolCount"]!.GetValue<long>());
            Assert.Empty(database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [LocalModelFact]
    public void RealOnnxInstallActivationAndVectorRetrievalAreOfflineAndRevisionScoped()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-model-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var bundle = Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!;
            using (var model = new LocalModel(bundle))
            {
                var vector = model.EmbedQuery("parse authentication token", CancellationToken.None); LocalModel.ValidateVector(vector);
                Assert.Equal(384, vector.Length);
                var chunks = model.EmbedRepresentation(string.Join(' ', Enumerable.Repeat("authentication token parser", 300)), CancellationToken.None);
                Assert.Equal(4, chunks.Count); Assert.All(chunks, LocalModel.ValidateVector);
            }
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize(); var indexer = new RepositoryIndexer(database);
            File.WriteAllText(Path.Combine(root, "Example.cs"), "class AuthenticationTokenParser { string ParseToken(string token) => token; }");
            var repository = indexer.Register(root); indexer.Index(repository);
            using var store = new ModelStore(database, Path.Combine(root, "models")); var profile = store.Install(bundle); store.Activate(repository, profile, CancellationToken.None);
            using (var read = database.Open(readOnly: true))
            using (var command = read.CreateCommand())
            {
                command.CommandText = "SELECT representation_version FROM model_profiles";
                Assert.Equal(2L, command.ExecuteScalar());
                command.CommandText = "SELECT v.spans_json FROM vectors v JOIN embedding_sets e ON e.set_id=v.set_id JOIN symbols s ON s.symbol_id=e.symbol_id WHERE s.name='ParseToken'";
                var spans = JsonNode.Parse((string)command.ExecuteScalar()!)!;
                Assert.Equal("utf16", spans["CoordinateBasis"]!.GetValue<string>());
                Assert.StartsWith("sha256:", spans["RepresentationHash"]!.GetValue<string>());
                var sourceSpan = Assert.Single(spans["Sources"]!.AsArray());
                var text = File.ReadAllText(Path.Combine(root, "Example.cs"));
                Assert.Contains("ParseToken", text[sourceSpan!["Start"]!.GetValue<int>()..sourceSpan["End"]!.GetValue<int>()]);
                Assert.Equal(SourceFiles.Hash(File.ReadAllBytes(Path.Combine(root, "Example.cs"))), sourceSpan["ContentHash"]!.GetValue<string>());
            }
            var queries = new QueryService(database, store);
            var input = new JsonObject { ["repositoryId"] = repository, ["query"] = "authentication token parsing", ["mode"] = "vector", ["responseBudgetTokens"] = 8000 };
            var response = queries.Execute("search_code", input, new HashSet<string> { repository }); Assert.Null(response["error"]);
            Assert.NotEmpty(response["data"]!["matches"]!.AsArray()); Assert.Equal("vector", response["data"]!["channelsUsed"]![0]!.GetValue<string>());
            Assert.True(response["data"]!["vectorCoveredSymbolCount"]!.GetValue<long>() > 0);
            File.AppendAllText(Path.Combine(root, "Example.cs"), " // changed");
            Assert.Contains("INDEX_STALE", Assert.Throws<IOException>(() => store.Activate(repository, profile, CancellationToken.None)).Message);
            indexer.Index(repository);
            var after = queries.Execute("search_code", input, new HashSet<string> { repository }); Assert.Null(after["error"]);
            Assert.NotEmpty(after["data"]!["matches"]!.AsArray());
            Assert.Equal(after["data"]!["eligibleSymbolCount"]!.GetValue<long>(), after["data"]!["vectorCoveredSymbolCount"]!.GetValue<long>());
            using (var read = database.Open(readOnly: true))
            using (var command = read.CreateCommand())
            {
                command.CommandText = "SELECT count(*) FROM jobs WHERE kind='embed' AND state='pending'"; Assert.Equal(0L, command.ExecuteScalar());
                command.CommandText = "SELECT v.spans_json FROM vectors v JOIN embedding_sets e ON e.set_id=v.set_id JOIN symbols s ON s.symbol_id=e.symbol_id WHERE s.name='ParseToken'";
                var metadata = JsonNode.Parse((string)command.ExecuteScalar()!)!;
                Assert.Equal(SourceFiles.Hash(File.ReadAllBytes(Path.Combine(root, "Example.cs"))), metadata["Sources"]![0]!["ContentHash"]!.GetValue<string>());
            }
            // A structurally complete set with corrupt vector values must never be reused.
            using (var write = database.Open())
            using (var command = write.CreateCommand())
            {
                command.CommandText = "UPDATE embedding_sets SET state='stale' WHERE symbol_id IN(SELECT symbol_id FROM symbols WHERE name='ParseToken'); UPDATE vectors SET values_blob=zeroblob(1536) WHERE set_id IN(SELECT e.set_id FROM embedding_sets e JOIN symbols s ON s.symbol_id=e.symbol_id WHERE s.name='ParseToken'); UPDATE embedding_sets SET state='ready' WHERE symbol_id IN(SELECT symbol_id FROM symbols WHERE name='ParseToken')";
                command.ExecuteNonQuery();
            }
            indexer.Index(repository, force: true);
            var methodsOnly = input.DeepClone().AsObject(); methodsOnly["filters"] = new JsonObject { ["kinds"] = new JsonArray("method") };
            Assert.Empty(queries.Execute("search_code", methodsOnly, new HashSet<string> { repository })["data"]!["matches"]!.AsArray());
            store.Activate(repository, profile, CancellationToken.None);
            Assert.NotEmpty(queries.Execute("search_code", methodsOnly, new HashSet<string> { repository })["data"]!["matches"]!.AsArray());
            indexer.Register(root, new(Excludes: ["Example.cs"]));
            using (var read = database.Open(readOnly: true))
            using (var command = read.CreateCommand())
            { command.CommandText = "SELECT count(*) FROM vectors"; Assert.Equal(0L, command.ExecuteScalar()); }
            Assert.Empty(database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
