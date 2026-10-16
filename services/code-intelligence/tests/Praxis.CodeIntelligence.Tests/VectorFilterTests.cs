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
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
