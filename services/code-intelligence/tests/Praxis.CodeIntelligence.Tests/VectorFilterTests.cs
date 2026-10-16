using System.Text.Json;
using Praxis.CodeIntelligence.Embeddings;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class VectorFilterTests
{
    [LocalModelFact]
    public void ExactCandidatesPreserveProjectContextKindAndEmptyFilterSemantics()
    {
        var root = Path.Combine(Path.GetTempPath(), "pci-vector-filters-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(Path.Combine(root, "Alpha.cs"), "public class Alpha { public int ParseAlpha() => 1; }");
            File.WriteAllText(Path.Combine(root, "Beta.cs"), "public class Beta { public int ParseBeta() => 2; }");
            var reference = typeof(object).Assembly.Location;
            var metadata = new[] { new MetadataInput(reference, SourceFiles.Hash(File.ReadAllBytes(reference))) };
            File.WriteAllText(Path.Combine(root, "context.praxis.json"), JsonSerializer.Serialize(new PassiveManifest(1,
                [new("alpha", "Alpha", ["Alpha.cs"], Metadata: metadata), new("beta", "Beta", ["Beta.cs"], Metadata: metadata)])));
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize();
            var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root, new("context.praxis.json"));
            indexer.Index(repository);
            using var models = new ModelStore(database, Path.Combine(root, "models"));
            var profile = models.Install(Environment.GetEnvironmentVariable("PRAXIS_MODEL_BUNDLE")!);
            models.Activate(repository, profile, CancellationToken.None);
            var query = models.QueryEmbedding(repository, "parse a token", CancellationToken.None)!;
            using var connection = database.Open(readOnly: true); using var snapshot = connection.BeginTransaction(deferred: true);
            var symbols = new Dictionary<string, (string Kind, string Context, string Project, string Key)>();
            using (var command = connection.CreateCommand())
            {
                command.Transaction = snapshot;
                command.CommandText = "SELECT s.symbol_id,s.kind,s.defining_context_id,c.project_id,p.project_key FROM symbols s JOIN contexts c ON c.context_id=s.defining_context_id JOIN projects p ON p.project_id=c.project_id WHERE s.external=0";
                using var reader = command.ExecuteReader();
                while (reader.Read()) symbols.Add(reader.GetString(0), (reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4)));
            }
            var all = ModelStore.Candidates(connection, snapshot, repository, query, null, null, null);
            Assert.Equal(symbols.Keys.Order(), all.Select(candidate => candidate.SymbolId).Order());
            var alpha = symbols.Values.First(symbol => symbol.Key == "alpha");
            var beta = symbols.Values.First(symbol => symbol.Key == "beta");
            void Check(string? context, string[]? kinds, string[]? projects,
                Func<(string Kind, string Context, string Project, string Key), bool> expected)
            {
                var actual = ModelStore.Candidates(connection, snapshot, repository, query, context, kinds, projects);
                Assert.Equal(all.Where(candidate => expected(symbols[candidate.SymbolId])), actual);
            }
            Check(null, [], [], _ => true);
            Check(alpha.Context, null, null, symbol => symbol.Context == alpha.Context);
            Check(null, null, [alpha.Project], symbol => symbol.Project == alpha.Project);
            Check(null, ["method"], null, symbol => symbol.Kind == "method");
            Check(alpha.Context, ["method"], [alpha.Project], symbol => symbol.Context == alpha.Context && symbol.Kind == "method");
            Check(alpha.Context, null, [beta.Project], _ => false);
            Check(null, null, ["missing"], _ => false);
            Check("missing", null, null, _ => false);
            snapshot.Commit();
            string corruptedSymbol, set; byte[] original;
            using (var select = connection.CreateCommand())
            {
                select.CommandText = "SELECT e.symbol_id,e.set_id,v.values_blob FROM embedding_sets e JOIN vectors v ON v.set_id=e.set_id WHERE e.expected_chunks=1 ORDER BY e.symbol_id LIMIT 1";
                using var reader = select.ExecuteReader(); Assert.True(reader.Read());
                corruptedSymbol = reader.GetString(0); set = reader.GetString(1); original = (byte[])reader.GetValue(2);
            }
            void Store(byte[] bytes)
            {
                using var writer = database.Open(); using var command = writer.CreateCommand();
                // Simulate on-disk corruption, bypassing only the length CHECK.
                // Normal publication cannot create these malformed rows.
                command.CommandText = "PRAGMA ignore_check_constraints=ON; UPDATE embedding_sets SET state='pending' WHERE set_id=$set; UPDATE vectors SET values_blob=$bytes WHERE set_id=$set; UPDATE embedding_sets SET state='ready' WHERE set_id=$set;";
                command.Parameters.AddWithValue("$set", set); command.Parameters.AddWithValue("$bytes", bytes);
                command.ExecuteNonQuery();
            }
            foreach (var length in new[] { original.Length - 4, original.Length + 4 })
            {
                var malformed = new byte[length]; original.AsSpan(0, Math.Min(length, original.Length)).CopyTo(malformed);
                Store(malformed);
                using var read = database.Open(readOnly: true); using var transaction = read.BeginTransaction(deferred: true);
                var actual = ModelStore.Candidates(read, transaction, repository, query, null, null, null);
                Assert.Equal(all.Where(candidate => candidate.SymbolId != corruptedSymbol), actual);
            }
            Store(original);
            Assert.Empty(database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
