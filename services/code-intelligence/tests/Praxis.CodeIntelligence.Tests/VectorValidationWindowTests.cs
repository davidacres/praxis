using Praxis.CodeIntelligence.Embeddings;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class VectorValidationWindowTests
{
    [LocalModelFact]
    public void RankedValidationEqualsTheExhaustiveScanForAnyWindowAndStaleness()
    {
        var root = Path.Combine(Path.GetTempPath(), "pci-vector-window-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(Path.Combine(root, "Many.cs"), string.Join('\n', Enumerable.Range(0, 120).Select(i =>
                $"public class Parse{i} {{ public int Run{i}() => {i}; }}")));
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize();
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root); indexer.Index(repository);
            using var models = new ModelStore(database, Path.Combine(root, "models"));
            models.Activate(repository, models.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!), CancellationToken.None);
            var query = models.QueryEmbedding(repository, "parse a token", CancellationToken.None)!;

            void Compare(string label)
            {
                using var connection = database.Open(readOnly: true); using var snapshot = connection.BeginTransaction(deferred: true);
                foreach (var kinds in new string[]?[] { null, ["method"], ["class"], ["missing"] })
                foreach (var window in new[] { 100, 128, 1024 })
                {
                    var expected = ModelStore.ExhaustiveCandidates(connection, snapshot, repository, query, null, kinds, null);
                    var actual = ModelStore.Candidates(connection, snapshot, repository, query, null, kinds, null, validationWindow: window);
                    Assert.True(expected.SequenceEqual(actual), $"{label}: kinds={(kinds is null ? "-" : string.Join(',', kinds))} window={window}");
                }
            }
            Compare("fresh");

            // Invalidate the best-ranked symbols so the window holds only stale
            // candidates and the exhaustive fallback must decide.
            string[] top;
            using (var connection = database.Open(readOnly: true)) using (var snapshot = connection.BeginTransaction(deferred: true))
                top = ModelStore.ExhaustiveCandidates(connection, snapshot, repository, query, null, null, null).Select(candidate => candidate.SymbolId).ToArray();
            Assert.Equal(100, top.Length);
            foreach (var count in new[] { 30, 100 })
            {
                using (var writer = database.Open())
                {
                    foreach (var symbol in top.Take(count))
                        writer.Execute(null, "UPDATE representation_targets SET eligibility='excluded', exclusion_reason='test' WHERE symbol_id=$0", symbol);
                }
                Compare($"excluded {count}");
            }
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
