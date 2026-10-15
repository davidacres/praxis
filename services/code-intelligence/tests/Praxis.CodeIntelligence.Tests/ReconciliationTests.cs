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
    public void LegacyContextsBackfillSnapshotWithoutChangingFactsOrGeneration()
    {
        File.WriteAllText(Path.Combine(Root, "Example.cs"), "class Example {}");
        var database = Database(); var indexer = new RepositoryIndexer(database); var id = indexer.Register(Root); var first = indexer.Index(id);
        using (var connection = database.Open())
        using (var command = connection.CreateCommand()) { command.CommandText = "UPDATE contexts SET options_json='{}'"; command.ExecuteNonQuery(); }
        var reconciled = indexer.Index(id); Assert.False(reconciled.Changed); Assert.Equal(first.Generation, reconciled.Generation);
        Assert.Equal(1, Count(database, "SELECT count(*) FROM contexts WHERE length(json_extract(options_json,'$.snapshotHash'))=71"));
        Assert.False(indexer.Index(id).Changed); Assert.Empty(database.Check());
    }
    public void Dispose() => Directory.Delete(temporary, recursive: true);
}
