using System.Text;
using System.Text.Json;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class IndexingTests : IDisposable
{
    private readonly string root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "praxis-index-tests-" + Guid.NewGuid().ToString("N"));
    private readonly IndexDatabase database;
    public IndexingTests() { Directory.CreateDirectory(root); database = new(System.IO.Path.Combine(root, "data", "index.db")); database.Initialize(); }
    private void Write(string path, string text) { var full = System.IO.Path.Combine(root, path); Directory.CreateDirectory(System.IO.Path.GetDirectoryName(full)!); File.WriteAllText(full, text); }

    [Fact]
    public void SyntaxFallbackPublishesEditsDeletesAndStableNoOpGeneration()
    {
        Write("Example.cs", "namespace App; class Example { void Run(int number) {} void Run(string name) {} }");
        var indexer = new RepositoryIndexer(database); var id = indexer.Register(root); Assert.Equal(id, indexer.Register(root));
        var first = indexer.Index(id); Assert.True(first.Changed); Assert.Equal(1, first.Generation);
        Assert.False(indexer.Index(id).Changed);
        using (var read = database.Open(readOnly: true))
        {
            using var command = read.CreateCommand(); command.CommandText = "SELECT symbol_id FROM symbols WHERE name='Run'";
            using var reader = command.ExecuteReader(); var ids = new List<string>(); while (reader.Read()) ids.Add(reader.GetString(0));
            Assert.Equal(2, ids.Count); Assert.Equal(2, ids.Distinct().Count()); Assert.All(ids, value => Assert.StartsWith("pci:syntactic:", value));
        }
        Write("Example.cs", "class Renamed {}"); Assert.Equal(2, indexer.Index(id).Generation);
        File.Delete(System.IO.Path.Combine(root, "Example.cs")); Assert.Equal(0, indexer.Index(id).Files);
        Assert.Empty(database.Check());
    }

    [Fact]
    public void CompilerResolvesCrossProjectCallsToDefiningContextAndPartialDeclarations()
    {
        const string library = "public partial class Library { public static int Target(int number) => number; }";
        const string caller = "class Caller { int Run() => Library.Target(3); }";
        var source = new[] { Source("Library.cs", library), Source("Caller.cs", caller), Source("Partial.cs", "public partial class Library {}") };
        var metadataPath = typeof(object).Assembly.Location;
        var metadata = new MetadataInput(metadataPath, SourceFiles.Hash(File.ReadAllBytes(metadataPath)));
        var manifest = new PassiveManifest(1, [new("Library", "Library", ["Library.cs", "Partial.cs"], Metadata: [metadata]), new("Caller", "Caller", ["Caller.cs"], ["Library"], [metadata])]);
        var result = new RoslynAnalyzer().Analyze("repo", source, manifest);
        Assert.All(result.Contexts, context => Assert.Equal("complete", context.Resolution));
        var target = Assert.Single(result.Symbols, s => s.Name == "Target");
        var call = Assert.Single(result.Calls); Assert.Equal(target.Id, call.TargetId); Assert.Equal("resolved", call.Resolution);
        Assert.NotEqual(call.ContextId, target.ContextId);
        Assert.Equal(2, Assert.Single(result.Symbols, s => s.Name == "Library").Locations.Count);
    }

    [Fact]
    public void SemanticIdentitySurvivesBodyAndParameterNameChanges()
    {
        var metadataPath = typeof(object).Assembly.Location;
        var manifest = new PassiveManifest(1, [new("project", "Project", ["Example.cs"], Metadata: [new(metadataPath, SourceFiles.Hash(File.ReadAllBytes(metadataPath)))])]);
        var analyzer = new RoslynAnalyzer();
        var first = analyzer.Analyze("repo", [Source("Example.cs", "class Example { int Run(int number) => number; }")], manifest);
        var second = analyzer.Analyze("repo", [Source("Example.cs", "class Example { int Run(int renamed) => renamed + 1; }")], manifest);
        var a = Assert.Single(first.Symbols, s => s.Name == "Run"); var b = Assert.Single(second.Symbols, s => s.Name == "Run");
        Assert.Equal(a.Id, b.Id); Assert.NotEqual(a.Revision, b.Revision); Assert.StartsWith("pci:sym:", a.Id);
    }

    [Fact]
    public void PassiveIndexingDoesNotEvaluateProjectAndExclusionsRevokePreviousFacts()
    {
        Write("Malicious.csproj", "<Project><Target Name='Build'><Exec Command='touch should-not-exist' /></Target></Project>");
        Write("private/Secret.cs", "class Secret {}"); Write("Public.cs", "class Public {}"); Write("obj/Generated.cs", "class Generated {}");
        var indexer = new RepositoryIndexer(database); var id = indexer.Register(root); Assert.Equal(2, indexer.Index(id).Files);
        indexer.Register(root, new(Excludes: ["private"]));
        using (var connection = database.Open(readOnly: true))
        { using var command = connection.CreateCommand(); command.CommandText = "SELECT count(*) FROM symbols"; Assert.Equal(0L, command.ExecuteScalar()); }
        Assert.Equal(1, indexer.Index(id).Files); Assert.False(File.Exists(System.IO.Path.Combine(root, "should-not-exist")));
        indexer.SetPaused(id, true); Assert.Throws<InvalidOperationException>(() => indexer.Index(id));
        indexer.SetPaused(id, false); indexer.Index(id); indexer.Unregister(id); Assert.Empty(indexer.List()); Assert.Empty(database.Check());
    }

    [Fact]
    public void StaleManifestDegradesWithoutExecutingAndUnreadableRootRetainsFacts()
    {
        Write("Example.cs", "class Example {}"); Write("Project.csproj", "<Project />");
        Write("context.praxis.json", JsonSerializer.Serialize(new PassiveManifest(1, [new("project", "Project", ["Example.cs"], Inputs: [new("Project.csproj", "sha256:" + new string('0', 64))])])));
        var indexer = new RepositoryIndexer(database); var id = indexer.Register(root, new("context.praxis.json")); indexer.Index(id);
        using var read = database.Open(readOnly: true); using var command = read.CreateCommand();
        command.CommandText = "SELECT count(*) FROM diagnostics WHERE code='INDEX_STALE'"; Assert.Equal(1L, command.ExecuteScalar());
        command.CommandText = "SELECT count(*) FROM symbols"; var before = command.ExecuteScalar();
        // Root-loss test uses a separate source root, leaving the DB accessible.
        var sourceRoot = System.IO.Path.Combine(root, "source-root"); Directory.CreateDirectory(sourceRoot); Write("source-root/Another.cs", "class Another {}");
        var lost = indexer.Register(sourceRoot); indexer.Index(lost); Directory.Move(sourceRoot, sourceRoot + "-gone");
        Assert.Throws<DirectoryNotFoundException>(() => indexer.Index(lost)); Assert.Equal("unknown", indexer.Get(lost).State);
        command.CommandText = "SELECT count(*) FROM symbols WHERE repository_id='" + lost + "'"; Assert.Equal(1L, command.ExecuteScalar());
        Assert.NotNull(before);
    }

    private static SourceInput Source(string path, string text) { var bytes = Encoding.UTF8.GetBytes(text); return new(path, SourceFiles.Hash(bytes), bytes, text); }
    public void Dispose() => Directory.Delete(root, recursive: true);
}
