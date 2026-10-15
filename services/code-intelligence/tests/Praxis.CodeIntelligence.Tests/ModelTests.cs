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
public sealed class ModelTests
{
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
        var fixture = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "minilm-golden.json")))!;
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
            await runtime.MaintainAsync(CancellationToken.None); await runtime.MaintainAsync(CancellationToken.None);
            JsonObject Search() => runtime.Dispatch(new JsonObject { ["action"] = "query", ["tool"] = "search_code", ["arguments"] = new JsonObject { ["repositoryId"] = id, ["query"] = "token parser", ["mode"] = "vector", ["responseBudgetTokens"] = 8000 } }, CancellationToken.None);
            Assert.NotEmpty(Search()["data"]!["matches"]!.AsArray());
            File.AppendAllText(Path.Combine(root, "Example.cs"), " // body revision");
            Assert.Null(runtime.Dispatch(new JsonObject { ["action"] = "index", ["repositoryId"] = id }, CancellationToken.None)["error"]);
            Assert.Empty(Search()["data"]!["matches"]!.AsArray());
            await runtime.MaintainAsync(CancellationToken.None); await runtime.MaintainAsync(CancellationToken.None);
            Assert.NotEmpty(Search()["data"]!["matches"]!.AsArray());
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
            Assert.Empty(after["data"]!["matches"]!.AsArray()); Assert.NotEmpty(after["warnings"]!.AsArray());
            Assert.Empty(database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
