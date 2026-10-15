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
            var queries = new QueryService(database, store);
            var input = new JsonObject { ["repositoryId"] = repository, ["query"] = "authentication token parsing", ["mode"] = "vector", ["responseBudgetTokens"] = 8000 };
            var response = queries.Execute("search_code", input, new HashSet<string> { repository }); Assert.Null(response["error"]);
            Assert.NotEmpty(response["data"]!["matches"]!.AsArray()); Assert.Equal("vector", response["data"]!["channelsUsed"]![0]!.GetValue<string>());
            Assert.True(response["data"]!["vectorCoveredSymbolCount"]!.GetValue<long>() > 0);
            File.AppendAllText(Path.Combine(root, "Example.cs"), " // changed"); indexer.Index(repository);
            var after = queries.Execute("search_code", input, new HashSet<string> { repository }); Assert.Null(after["error"]);
            Assert.Empty(after["data"]!["matches"]!.AsArray()); Assert.NotEmpty(after["warnings"]!.AsArray());
            Assert.Empty(database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
