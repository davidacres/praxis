using System.Text.Json;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class ReconciliationTests : IDisposable
{
    private readonly string temporary = Path.Combine(Path.GetTempPath(), "praxis-reconcile-" + Guid.NewGuid().ToString("N"));
    private string Root => Path.Combine(temporary, "source");
    public ReconciliationTests() => Directory.CreateDirectory(Root);
    private IndexDatabase Database()
    {
        var database = new IndexDatabase(Path.Combine(temporary, "data", "index.db")); database.Initialize(); return database;
    }
    private static long Count(IndexDatabase database, string sql)
    {
        using var connection = database.Open(readOnly: true); using var command = connection.CreateCommand(); command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar());
    }
    [Fact]
    public void ReconciliationHashesBytesEvenWhenLengthAndTimestampStayTheSame()
    {
        var path = Path.Combine(Root, "Example.cs"); File.WriteAllText(path, "class Alpha {}"); var timestamp = File.GetLastWriteTimeUtc(path);
        var database = Database(); var indexer = new RepositoryIndexer(database); var id = indexer.Register(Root);
        var first = indexer.Index(id); var epoch = indexer.Get(id).QueryEpoch;
        Assert.False(indexer.Index(id).Changed); Assert.Equal(epoch, indexer.Get(id).QueryEpoch);
        File.WriteAllText(path, "class Bravo {}"); File.SetLastWriteTimeUtc(path, timestamp);
        var edited = indexer.Index(id); Assert.True(edited.Changed); Assert.Equal(first.Generation + 1, edited.Generation);
        Assert.Equal(0, Count(database, "SELECT count(*) FROM symbols WHERE name='Alpha'"));
        Assert.Equal(1, Count(database, "SELECT count(*) FROM symbols WHERE name='Bravo'"));
        Assert.True(indexer.Index(id, force: true).Changed); Assert.Empty(database.Check());
    }
    [Fact]
    public void UnchangedSourcesCannotReuseFactsAfterCapturedReferenceChanges()
    {
        var reference = Path.Combine(temporary, "reference.dll"); File.Copy(typeof(object).Assembly.Location, reference);
        File.WriteAllText(Path.Combine(Root, "Example.cs"), "class Example { int Run() => 1; }");
        var manifest = new PassiveManifest(1, [new("project", "Project", ["Example.cs"], Metadata: [new(reference, SourceFiles.Hash(File.ReadAllBytes(reference)))])]);
        File.WriteAllText(Path.Combine(Root, "context.praxis.json"), JsonSerializer.Serialize(manifest));
        var database = Database(); var indexer = new RepositoryIndexer(database); var id = indexer.Register(Root, new("context.praxis.json"));
        indexer.Index(id); Assert.False(indexer.Index(id).Changed);
        File.WriteAllBytes(reference, [0, 1, 2, 3]);
        Assert.True(indexer.Index(id).Changed);
        Assert.Equal(1, Count(database, "SELECT count(*) FROM diagnostics WHERE code='INDEX_STALE'"));
        Assert.Equal(1, Count(database, "SELECT count(*) FROM contexts WHERE resolution='syntaxOnly'"));
        Assert.Equal(0, Count(database, "SELECT count(*) FROM symbols WHERE external=0 AND resolution!='syntaxOnly'"));
        Assert.Empty(database.Check());
    }
    [Fact]
    public void CurrentRepresentationsBackfillSnapshotWithoutChangingFactsOrGeneration()
    {
        File.WriteAllText(Path.Combine(Root, "Example.cs"), "class Example {}");
        var database = Database(); var indexer = new RepositoryIndexer(database); var id = indexer.Register(Root); var first = indexer.Index(id);
        using (var connection = database.Open())
        using (var command = connection.CreateCommand()) { command.CommandText = "UPDATE contexts SET options_json=json_remove(options_json,'$.snapshotHash')"; command.ExecuteNonQuery(); }
        var reconciled = indexer.Index(id); Assert.False(reconciled.Changed); Assert.Equal(first.Generation, reconciled.Generation);
        Assert.Equal(1, Count(database, "SELECT count(*) FROM contexts WHERE length(json_extract(options_json,'$.snapshotHash'))=71"));
        Assert.False(indexer.Index(id).Changed); Assert.Empty(database.Check());
    }
    [Fact]
    public void RebuildAndUnregisterPreserveAnotherRepositoriesRelationships()
    {
        File.WriteAllText(Path.Combine(Root, "Example.cs"), "class Example { int Target() => 1; int Caller() => Target(); }");
        var other = Path.Combine(temporary, "other"); Directory.CreateDirectory(other);
        File.Copy(Path.Combine(Root, "Example.cs"), Path.Combine(other, "Example.cs"));
        var database = Database(); var indexer = new RepositoryIndexer(database);
        var reference = typeof(object).Assembly.Location;
        var manifest = JsonSerializer.Serialize(new PassiveManifest(1, [new("project", "Project", ["Example.cs"],
            Metadata: [new(reference, SourceFiles.Hash(File.ReadAllBytes(reference)))])]));
        File.WriteAllText(Path.Combine(Root, "context.praxis.json"), manifest);
        File.WriteAllText(Path.Combine(other, "context.praxis.json"), manifest);
        var first = indexer.Register(Root, new("context.praxis.json")); var second = indexer.Register(other, new("context.praxis.json"));
        indexer.Index(first); indexer.Index(second);
        string OtherRelationships()
        {
            using var connection = database.Open(readOnly: true); using var command = connection.CreateCommand();
            command.CommandText = "SELECT e.edge_id,e.source_symbol_id,e.target_symbol_id,o.content_hash,o.range_json FROM edges e JOIN occurrences o ON o.occurrence_id=e.occurrence_id JOIN symbols s ON s.symbol_id=e.source_symbol_id WHERE s.repository_id=$id ORDER BY e.edge_id";
            command.Parameters.AddWithValue("$id", second); using var reader = command.ExecuteReader();
            var rows = new List<string>();
            while (reader.Read()) rows.Add(JsonSerializer.Serialize(Enumerable.Range(0, reader.FieldCount).Select(reader.GetValue)));
            return string.Join("\n", rows);
        }
        var before = OtherRelationships(); Assert.NotEmpty(before);
        File.WriteAllText(Path.Combine(Root, "Example.cs"), "class Replacement {}");
        indexer.Index(first);
        Assert.Equal(before, OtherRelationships()); Assert.Empty(database.Check());
        indexer.Unregister(first);
        Assert.Equal(before, OtherRelationships()); Assert.Empty(database.Check());
        Assert.False(indexer.Index(second).Changed);
    }

    public void Dispose() => Directory.Delete(temporary, recursive: true);
}
