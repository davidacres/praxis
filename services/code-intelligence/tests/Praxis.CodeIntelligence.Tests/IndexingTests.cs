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
        command.CommandText = "SELECT count(*) FROM symbols WHERE repository_id='" + lost + "'"; Assert.Equal(2L, command.ExecuteScalar());
        Assert.NotNull(before);
    }

    [Fact]
    public void NestedCallablesOwnTheirCallsAndUseStableScopedIdentities()
    {
        const string code = "class Example { static int Target() => 1; int Run() { System.Func<int> first = () => Target(); System.Func<int> second = delegate { return Target(); }; int Local() { System.Func<int> nested = () => Target(); return nested(); } return Local(); } }";
        var metadataPath = typeof(object).Assembly.Location;
        var manifest = new PassiveManifest(1, [new("project", "Project", ["Example.cs"], Metadata: [new(metadataPath, SourceFiles.Hash(File.ReadAllBytes(metadataPath)))])]);
        var analyzer = new RoslynAnalyzer();
        var first = analyzer.Analyze("repo", [Source("Example.cs", code)], manifest);
        Assert.All(first.Contexts, context => Assert.Equal("complete", context.Resolution));
        var functions = first.Symbols.Where(s => s.Kind == "function").ToArray();
        Assert.Equal(4, functions.Length);
        Assert.Equal(4, functions.Select(s => s.Id).Distinct().Count());
        var target = Assert.Single(first.Symbols, s => s.Name == "Target");
        var targetCalls = first.Calls.Where(c => c.TargetId == target.Id).ToArray();
        Assert.Equal(3, targetCalls.Length);
        Assert.All(targetCalls, call => Assert.Contains(functions, s => s.Id == call.OwnerId));
        var local = Assert.Single(functions, s => s.Name == "Local");
        Assert.Single(functions, s => s.ContainerId == local.Id);
        Assert.Contains(first.Calls, c => c.TargetId == local.Id);
        // Offsets and parameter/body text do not define a local callable identity.
        var changed = code.Replace("int Run()", "int Run(/* offset change */)").Replace("=> Target();", "=> Target() + 2;");
        var second = analyzer.Analyze("repo", [Source("Example.cs", changed)], manifest);
        Assert.Equal(functions.Select(s => s.Id).Order(), second.Symbols.Where(s => s.Kind == "function").Select(s => s.Id).Order());
        Assert.All(first.Calls.Where(c => c.TargetId is not null), call => Assert.Contains(first.Symbols, s => s.Id == call.TargetId));
    }

    [Fact]
    public void InitializerCallsBelongToTheTypeRatherThanNonCallableMembers()
    {
        const string code = "class Example { static int Target() => 1; int field = Target(); int Property { get; } = Target(); System.Func<int> callback = () => Target(); }";
        var result = new RoslynAnalyzer().Analyze("repo", [Source("Example.cs", code)], null);
        var type = Assert.Single(result.Symbols, s => s.Kind == "type");
        var lambda = Assert.Single(result.Symbols, s => s.Kind == "function");
        Assert.Equal(3, result.Calls.Count);
        Assert.Equal(2, result.Calls.Count(c => c.OwnerId == type.Id));
        Assert.Single(result.Calls, c => c.OwnerId == lambda.Id);
        Assert.All(result.Symbols, s => Assert.StartsWith("pci:syntactic:", s.Id));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void TopLevelStatementsHaveLabelledSyntheticOwnersAndDistinctLocalIdentities(bool semantic)
    {
        const string code = "System.Func<int> first = () => Target(); System.Func<int> second = () => Target(); int Target() => 1; var result = Target(); class Other {}";
        var metadataPath = typeof(object).Assembly.Location;
        var manifest = semantic ? new PassiveManifest(1, [new("app", "App", ["Program.cs"], Metadata: [new(metadataPath, SourceFiles.Hash(File.ReadAllBytes(metadataPath)))], OutputKind: "exe")]) : null;
        var result = new RoslynAnalyzer().Analyze("repo", [Source("Program.cs", code)], manifest);
        Assert.Equal(semantic ? "complete" : "syntaxOnly", Assert.Single(result.Contexts).Resolution);
        var module = Assert.Single(result.Symbols, s => s.Kind == "module");
        Assert.Empty(module.Locations);
        var entry = Assert.Single(result.Symbols, s => s.Name == "[synthetic top-level entry]");
        Assert.Equal(module.Id, entry.ContainerId);
        Assert.Single(entry.Locations);
        var type = Assert.Single(result.Symbols, s => s.Name == "Other");
        Assert.Equal(module.Id, type.ContainerId);
        var functions = result.Symbols.Where(s => s.Kind == "function").ToArray();
        Assert.Equal(3, functions.Length);
        Assert.Equal(3, functions.Select(s => s.Id).Distinct().Count());
        Assert.All(functions, s => Assert.Equal(entry.Id, s.ContainerId));
        Assert.Equal(3, result.Calls.Count);
        Assert.Single(result.Calls, c => c.OwnerId == entry.Id);
        Assert.All(result.Calls, call => Assert.Contains(result.Symbols, s => s.Id == call.OwnerId));
        if (semantic) Assert.All(result.Calls, call => Assert.Equal("resolved", call.Resolution));
    }

    [Fact]
    public void ImplicitSourceConstructorsAreNotMisclassifiedAsExternalMetadata()
    {
        var metadataPath = typeof(object).Assembly.Location;
        var manifest = new PassiveManifest(1, [new("library", "Library", ["Example.cs"], Metadata: [new(metadataPath, SourceFiles.Hash(File.ReadAllBytes(metadataPath)))]),
            new("caller", "Caller", ["Caller.cs"], ["library"], [new(metadataPath, SourceFiles.Hash(File.ReadAllBytes(metadataPath)))])]);
        var result = new RoslynAnalyzer().Analyze("repo", [Source("Example.cs", "public class Example {}"), Source("Caller.cs", "class Caller { Example Make() => new(); }")], manifest);
        Assert.All(result.Contexts, context => Assert.Equal("complete", context.Resolution));
        var call = Assert.Single(result.Calls);
        var constructor = Assert.Single(result.Symbols, s => s.Id == call.TargetId);
        Assert.False(constructor.External); Assert.Equal("constructor", constructor.Kind); Assert.Empty(constructor.Locations);
        var type = Assert.Single(result.Symbols, s => s.Name == "Example");
        Assert.Equal(type.Id, constructor.ContainerId); Assert.Equal(type.ContextId, constructor.ContextId);
        Assert.NotEqual(call.ContextId, constructor.ContextId); Assert.Equal("resolved", call.Resolution);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void EditedPublicationMatchesACleanIndexAcrossCompilerContexts(bool sameShape)
    {
        var sourceRoot = System.IO.Path.Combine(root, "source"); Directory.CreateDirectory(sourceRoot);
        void SourceFile(string path, string text) => File.WriteAllText(System.IO.Path.Combine(sourceRoot, path), text);
        var metadataPath = typeof(object).Assembly.Location;
        var metadata = new MetadataInput(metadataPath, SourceFiles.Hash(File.ReadAllBytes(metadataPath)));
        var manifest = new PassiveManifest(1, [new("library", "Library", ["Library.cs", "Partial.cs"], Metadata: [metadata]),
            new("caller", "Caller", ["Caller.cs"], ["library"], [metadata])]);
        SourceFile("Library.cs", "namespace App; public partial class Library { public static int Target(int value) => value; }");
        SourceFile("Partial.cs", "namespace App; public partial class Library {}");
        SourceFile("Caller.cs", "namespace App; class Caller { int Run() => Library.Target(1); }");
        SourceFile("context.praxis.json", JsonSerializer.Serialize(manifest));
        var edited = new RepositoryIndexer(database); var id = edited.Register(sourceRoot, new("context.praxis.json")); edited.Index(id);
        SourceFile("Library.cs", "namespace App; public partial class Library { public static int Target(int renamed) => renamed + 2; }");
        if (sameShape)
            SourceFile("Caller.cs", "namespace App; class Caller { int Run() => Library.Target(42); }");
        else
        {
            SourceFile("Addition.cs", "namespace App; public class Addition : Library {}");
            File.Delete(System.IO.Path.Combine(sourceRoot, "Partial.cs"));
            SourceFile("Caller.cs", "namespace App; class Caller { int Run() { System.Func<int> next = () => Library.Target(3); return next(); } }");
            manifest = manifest with { Projects = [manifest.Projects[0] with { Sources = ["Library.cs", "Addition.cs"] }, manifest.Projects[1]] };
            SourceFile("context.praxis.json", JsonSerializer.Serialize(manifest));
        }
        Assert.Equal(2, edited.Index(id).Generation);
        var cleanDatabase = new IndexDatabase(System.IO.Path.Combine(root, "clean", "index.db")); cleanDatabase.Initialize();
        using (var connection = cleanDatabase.Open())
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "INSERT INTO repositories(repository_id,canonical_root,path_policy,config_json) VALUES($id,$root,$policy,$config)";
            command.Parameters.AddWithValue("$id", id); command.Parameters.AddWithValue("$root", SourceFiles.CanonicalDirectory(sourceRoot));
            command.Parameters.AddWithValue("$policy", OperatingSystem.IsWindows() ? "caseInsensitive" : "caseSensitive");
            command.Parameters.AddWithValue("$config", JsonSerializer.Serialize(new RepositoryConfig("context.praxis.json"))); command.ExecuteNonQuery();
        }
        Assert.Equal(1, new RepositoryIndexer(cleanDatabase).Index(id).Generation);
        Assert.Equal(StructuralSnapshot(cleanDatabase), StructuralSnapshot(database));
        Assert.Empty(database.Check()); Assert.Empty(cleanDatabase.Check());
    }

    [Fact]
    public void FailedRetainedPublicationRollsBackFactsAndGeneration()
    {
        Write("Example.cs", "class Example { int First() => 1; int Second() => 2; int Run() => First(); }");
        var indexer = new RepositoryIndexer(database); var id = indexer.Register(root); indexer.Index(id);
        var before = StructuralSnapshot(database); var repository = indexer.Get(id);
        using (var connection = database.Open())
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "CREATE TRIGGER fail_publication BEFORE INSERT ON occurrences BEGIN SELECT RAISE(ABORT,'publication failed'); END";
            command.ExecuteNonQuery();
        }
        Write("Example.cs", "class Example { int First() => 1; int Second() => 2; int Run() => Second(); }");
        Assert.Throws<Microsoft.Data.Sqlite.SqliteException>(() => indexer.Index(id));
        Assert.Equal(repository, indexer.Get(id)); Assert.Equal(before, StructuralSnapshot(database)); Assert.Empty(database.Check());
        using (var connection = database.Open())
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "DROP TRIGGER fail_publication; CREATE TRIGGER preserve_parent BEFORE DELETE ON symbols BEGIN SELECT RAISE(ABORT,'parent deleted'); END";
            command.ExecuteNonQuery();
        }
        Assert.Equal(repository.Generation + 1, indexer.Index(id).Generation);
        Assert.Empty(database.Check());
    }

    private static string StructuralSnapshot(IndexDatabase database)
    {
        string[] queries = [
            "SELECT symbol_id,defining_context_id,descriptor_json,kind,name,qualified_name,signature,revision,external,resolution,containment_id FROM symbols",
            "SELECT project_id,project_key,relative_path,language FROM projects",
            "SELECT context_id,project_id,slot_key,context_hash,api_hash,adapter_version,options_json,resolution,capabilities_json FROM contexts",
            "SELECT relative_path,path_key,observed_hash,size_bytes,language,role,state FROM files",
            "SELECT l.symbol_id,l.context_id,f.relative_path,l.content_hash,l.start_offset,l.end_offset,l.start_line,l.start_character,l.end_line,l.end_character,l.role FROM locations l JOIN files f ON f.file_id=l.file_id",
            "SELECT o.occurrence_id,o.context_id,f.relative_path,o.owner_symbol_id,o.target_symbol_id,o.content_hash,o.start_offset,o.end_offset,o.range_json,o.resolution FROM occurrences o JOIN files f ON f.file_id=o.file_id",
            "SELECT e.edge_id,e.owner_context_id,f.relative_path,e.source_symbol_id,e.target_symbol_id,e.occurrence_id,e.kind,e.provenance,e.resolution,e.input_revision,e.evidence_key FROM edges e LEFT JOIN files f ON f.file_id=e.owner_file_id",
            "SELECT symbol_id,input_revision,name,signature,documentation,description FROM search_documents",
            "SELECT d.context_id,f.relative_path,d.code,d.severity,d.message,d.range_json FROM diagnostics d LEFT JOIN files f ON f.file_id=d.file_id"
        ];
        var rows = new List<string>(); using var connection = database.Open(readOnly: true);
        for (var query = 0; query < queries.Length; query++)
        {
            using var command = connection.CreateCommand(); command.CommandText = queries[query]; using var reader = command.ExecuteReader();
            while (reader.Read()) rows.Add(query + ":" + JsonSerializer.Serialize(Enumerable.Range(0, reader.FieldCount).Select(column => reader.IsDBNull(column) ? null : reader.GetValue(column)).ToArray()));
        }
        return string.Join("\n", rows.Order(StringComparer.Ordinal));
    }

    private static SourceInput Source(string path, string text) { var bytes = Encoding.UTF8.GetBytes(text); return new(path, SourceFiles.Hash(bytes), bytes, text); }
    public void Dispose() => Directory.Delete(root, recursive: true);
}
