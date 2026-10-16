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
            Assert.Empty(database.Check());

            // A schema-4 database gains vector_scan through the migration backfill.
            using (var writer = database.Open())
                writer.Execute(null, "DROP TRIGGER vector_scan_insert; DROP TRIGGER vector_scan_update; DROP TRIGGER vector_scan_delete; DROP TRIGGER vector_scan_set_update; DROP TRIGGER vector_scan_symbol_update; DROP TABLE vector_scan; DELETE FROM schema_migrations WHERE version>=5; PRAGMA user_version=4;");
            database.Initialize();
            Assert.Empty(database.Check());
            Compare("upgraded");

            // Republishing after an edit keeps the copy in step through reuse,
            // stale marking and deletion.
            File.AppendAllText(Path.Combine(root, "Many.cs"), "\npublic class Tokenizer { public int Split() => 0; }");
            indexer.Index(repository);
            models.Activate(repository, models.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!), CancellationToken.None);
            Assert.Empty(database.Check());
            Compare("edited");

            // Invalidate the best-ranked symbols so the window holds only stale
            // candidates and the exhaustive fallback must decide.
            string[] top;
            using (var connection = database.Open(readOnly: true)) using (var snapshot = connection.BeginTransaction(deferred: true))
                top = ModelStore.ExhaustiveCandidates(connection, snapshot, repository, query, null, null, null).Select(candidate => candidate.SymbolId).ToArray();
            Assert.Equal(100, top.Length);
            // A symbol's kind change reaches the copy in the same transaction, so
            // kind-filtered fast paths still match the exhaustive scan.
            using (var writer = database.Open())
                writer.Execute(null, "UPDATE symbols SET kind=CASE kind WHEN 'method' THEN 'class' ELSE 'method' END WHERE symbol_id=$0", top[1]);
            Assert.Empty(database.Check());
            Compare("kind changed");

            // Drift between vector_scan and vectors is detected: by rescoring at
            // query time (the exhaustive scan then decides) and by Check().
            using (var writer = database.Open())
                writer.Execute(null, "UPDATE vector_scan SET values_blob=(SELECT values_blob FROM vector_scan WHERE symbol_id=$1 LIMIT 1) WHERE symbol_id=$0", top[0], top[^1]);
            Assert.NotEmpty(database.Check());
            Compare("drifted");
            using (var writer = database.Open())
                writer.Execute(null, "DELETE FROM vector_scan; INSERT INTO vector_scan SELECT v.set_id,v.chunk_index,e.symbol_id,e.model_fingerprint,e.state='ready',s.defining_context_id,s.kind,v.dimensions,v.values_blob FROM vectors v JOIN embedding_sets e ON e.set_id=v.set_id LEFT JOIN symbols s ON s.symbol_id=e.symbol_id");
            Assert.Empty(database.Check());

            foreach (var count in new[] { 30, 100 })
            {
                using (var writer = database.Open())
                {
                    foreach (var symbol in top.Take(count))
                        writer.Execute(null, "UPDATE representation_targets SET eligibility='excluded', exclusion_reason='test' WHERE symbol_id=$0", symbol);
                }
                Compare($"excluded {count}");
                Assert.Empty(database.Check());
            }
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
