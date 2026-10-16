using System.Text.Json;
using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Embeddings;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class SourceLifecycleTests
{
    [LocalModelFact]
    public void RenameMoveAndDeleteWithdrawOldSourceAliasesRelationshipsAndVectors()
    {
        var temporary = Path.Combine(Path.GetTempPath(), "pci-source-lifecycle-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(temporary, "source"); Directory.CreateDirectory(root);
        try
        {
            var database = new IndexDatabase(Path.Combine(temporary, "data", "index.db")); database.Initialize();
            var file = "Example.cs";
            void WriteManifest()
            {
                var metadata = typeof(object).Assembly.Location;
                File.WriteAllText(Path.Combine(root, "context.praxis.json"), JsonSerializer.Serialize(new PassiveManifest(1,
                    [new("project", "Project", File.Exists(Path.Combine(root, file)) ? [file] : [],
                        Metadata: [new(metadata, SourceFiles.Hash(File.ReadAllBytes(metadata)))])])));
            }
            File.WriteAllText(Path.Combine(root, file), "class Example { int Before() => 1; int Caller() => Before(); }"); WriteManifest();
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root, new("context.praxis.json")); indexer.Index(repository);
            using var store = new ModelStore(database, Path.Combine(temporary, "models"));
            var profile = store.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!); store.Activate(repository, profile, CancellationToken.None);
            var queries = new QueryService(database, store);
            JsonObject Query(string tool, JsonObject input)
            {
                input["repositoryId"] = repository; input["responseBudgetTokens"] = 8000;
                return queries.Execute(tool, input, new HashSet<string> { repository });
            }
            JsonObject Find(string name) => Query("find_symbol", new() { ["name"] = name });
            JsonObject Source(string symbol) => Query("get_source", new() { ["symbolId"] = symbol });
            string Id(string name) => Assert.Single(Find(name)["data"]!["items"]!.AsArray())!["symbolId"]!.GetValue<string>();
            void AssertCoverageAndNoGhosts(string? forbidden)
            {
                var response = Query("search_code", new() { ["query"] = "Before After Caller", ["mode"] = "vector" });
                Assert.Null(response["error"]);
                Assert.Equal(response["data"]!["eligibleSymbolCount"]!.GetValue<long>(), response["data"]!["vectorCoveredSymbolCount"]!.GetValue<long>());
                if (forbidden is not null)
                    Assert.DoesNotContain(response["data"]!["matches"]!.AsArray(), match => match!["symbol"]!["symbolId"]!.GetValue<string>() == forbidden);
                Assert.Empty(database.Check());
            }
            var old = Id("Before");
            indexer.AddAlias(repository, old, "retired operation");
            Assert.Single(Query("get_callers", new() { ["symbolId"] = old })["data"]!["items"]!.AsArray());
            var snapshot = Query("find_symbol", new() { ["name"] = "Caller", ["limit"] = 1 });
            var oldHash = Source(old)["data"]!["fragments"]![0]!["currentHash"]!.GetValue<string>();
            File.WriteAllText(Path.Combine(root, file), "class Example { int After() => 2; int Caller() => After(); }");
            Assert.Equal("SOURCE_CHANGED", Source(old)["error"]!["code"]!.GetValue<string>());
            Assert.True(indexer.Index(repository).Changed);
            Assert.Empty(Find("Before")["data"]!["items"]!.AsArray());
            Assert.Equal("SYMBOL_NOT_FOUND", Source(old)["error"]!["code"]!.GetValue<string>());
            Assert.Empty(Query("search_code", new() { ["query"] = "retired operation", ["mode"] = "lexical" })["data"]!["matches"]!.AsArray());
            var current = Id("After"); Assert.NotEqual(old, current);
            var calls = Query("get_callees", new() { ["symbolId"] = Id("Caller") });
            Assert.Equal(current, Assert.Single(calls["data"]!["items"]!.AsArray())!["targetSymbolId"]!.GetValue<string>());
            Assert.NotEqual(oldHash, Source(current)["data"]!["fragments"]![0]!["currentHash"]!.GetValue<string>());
            Assert.True(snapshot["queryEpoch"]!.GetValue<long>() < Find("After")["queryEpoch"]!.GetValue<long>());
            store.Activate(repository, profile, CancellationToken.None); AssertCoverageAndNoGhosts(old);

            File.Move(Path.Combine(root, file), Path.Combine(root, "Moved.cs")); file = "Moved.cs"; WriteManifest();
            Assert.Equal("SOURCE_UNREADABLE", Source(current)["error"]!["code"]!.GetValue<string>());
            Assert.True(indexer.Index(repository).Changed);
            current = Id("After");
            var moved = Source(current); Assert.Null(moved["error"]);
            Assert.Contains(moved["evidence"]!.AsArray(), evidence => evidence!["path"]?.GetValue<string>() == "Moved.cs");
            store.Activate(repository, profile, CancellationToken.None); AssertCoverageAndNoGhosts(old);

            File.Delete(Path.Combine(root, file)); WriteManifest();
            Assert.Equal("SOURCE_UNREADABLE", Source(current)["error"]!["code"]!.GetValue<string>());
            Assert.True(indexer.Index(repository).Changed);
            Assert.Empty(Find("After")["data"]!["items"]!.AsArray());
            Assert.Empty(Find("Caller")["data"]!["items"]!.AsArray());
            Assert.Equal("SYMBOL_NOT_FOUND", Source(current)["error"]!["code"]!.GetValue<string>());
            store.Activate(repository, profile, CancellationToken.None); AssertCoverageAndNoGhosts(current);
            using var connection = database.Open(readOnly: true); using var command = connection.CreateCommand();
            command.CommandText = "SELECT (SELECT count(*) FROM vectors v JOIN embedding_sets e ON e.set_id=v.set_id JOIN symbols s ON s.symbol_id=e.symbol_id WHERE s.name IN('Before','After','Caller','Example'))+(SELECT count(*) FROM embedding_sets e JOIN symbols s ON s.symbol_id=e.symbol_id WHERE s.name IN('Before','After','Caller','Example'))+(SELECT count(*) FROM edges)+(SELECT count(*) FROM aliases)+(SELECT count(*) FROM locations)";
            Assert.Equal(0L, command.ExecuteScalar()); Assert.Empty(database.Check());
        }
        finally { Directory.Delete(temporary, recursive: true); }
    }
}
