using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class LexicalWindowTests
{
    [Fact]
    public void WindowedLexicalRankingEqualsTheFullRankedJoin()
    {
        var root = Path.Combine(Path.GetTempPath(), "pci-lexical-window-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            // Many equal-scoring matches exercise the symbol-ID tie-break, and
            // names equal to a query exercise the exact-name-first ordering.
            File.WriteAllText(Path.Combine(root, "Many.cs"), string.Join('\n', Enumerable.Range(0, 250).Select(i =>
                $"public class Parse{i} {{ public int Run{i}() => {i}; public int Parse() => 0; }}")) + "\npublic class Run { public int Parse7() => 7; }");
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize();
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root); indexer.Index(repository);
            string Search(int window, string query, string[]? kinds)
            {
                var arguments = new JsonObject { ["repositoryId"] = repository, ["query"] = query, ["mode"] = "lexical", ["limit"] = 50 };
                if (kinds is not null) arguments["filters"] = new JsonObject { ["kinds"] = new JsonArray(kinds.Select(kind => (JsonNode?)kind).ToArray()) };
                var response = new QueryService(database) { LexicalWindow = window }.Execute("search_code", arguments, new HashSet<string> { repository });
                Assert.Null(response["error"]);
                return response["data"]!.ToJsonString();
            }
            foreach (var query in new[] { "Parse7", "Parse", "Run", "Parse Run", "token missing" })
            foreach (var kinds in new string[]?[] { null, ["method"], ["class"] })
            {
                var expected = Search(0, query, kinds);
                foreach (var window in new[] { 1, 7, 150, 1024 })
                    Assert.True(expected == Search(window, query, kinds), $"query={query} kinds={(kinds is null ? "-" : kinds[0])} window={window}");
            }
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
