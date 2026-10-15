using System.Text.Json;
using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class SdkFactAttribute : FactAttribute
{
    public SdkFactAttribute() { if (Environment.GetEnvironmentVariable("PRAXIS_DOTNET") is null) Skip = "Explicit SDK executable is required for context-capture integration."; }
}
public sealed class CaptureTests
{
    [Fact]
    public void GeneratedSemanticSupportEnablesResolutionWithoutReturningItsSource()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-support-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Path.Combine(root, "obj"));
        try
        {
            File.WriteAllText(Path.Combine(root, "Example.cs"), "class Example { DateTime Now() => DateTime.Now; }");
            File.WriteAllText(Path.Combine(root, "obj", "Global.g.cs"), "global using System;");
            var metadata = typeof(object).Assembly.Location;
            File.WriteAllText(Path.Combine(root, "context.praxis.json"), JsonSerializer.Serialize(new PassiveManifest(1,
                [new("project", "Project", ["Example.cs"], Metadata: [new(metadata, SourceFiles.Hash(File.ReadAllBytes(metadata)))], SupportSources: ["obj/Global.g.cs"], Nullable: "enable")])));
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize(); var indexer = new RepositoryIndexer(database);
            var repository = indexer.Register(root, new("context.praxis.json")); indexer.Index(repository);
            using var connection = database.Open(readOnly: true); using var command = connection.CreateCommand();
            command.CommandText = "SELECT resolution FROM contexts"; Assert.Equal("complete", command.ExecuteScalar());
            command.CommandText = "SELECT file_id FROM files WHERE role='semanticSupport'"; var fileId = (string)command.ExecuteScalar()!;
            command.CommandText = "SELECT count(*) FROM locations l JOIN files f ON f.file_id=l.file_id WHERE f.role='semanticSupport'"; Assert.Equal(0L, command.ExecuteScalar());
            var response = new QueryService(database).Execute("get_source", new JsonObject { ["repositoryId"] = repository, ["fileId"] = fileId,
                ["range"] = new JsonObject { ["start"] = new JsonObject { ["line"] = 0, ["character"] = 0 }, ["end"] = new JsonObject { ["line"] = 0, ["character"] = 6 } } }, new HashSet<string> { repository });
            Assert.Equal("FILE_NOT_FOUND", response["error"]!["code"]!.GetValue<string>());
            indexer.Register(root, new(Excludes: ["obj"])); indexer.Index(repository);
            command.CommandText = "SELECT count(*) FROM files WHERE role='semanticSupport'"; Assert.Equal(0L, command.ExecuteScalar());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [SdkFact]
    public async Task ExplicitSdkCaptureProducesHashCheckedPassiveContext()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-capture-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(Path.Combine(root, "Example.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>");
            File.WriteAllText(Path.Combine(root, "Example.cs"), "public class Example { public int Run(int input) => input + 1; }");
            var output = await ContextCapture.CaptureAsync(root, "Example.csproj", restore: true);
            var manifest = PassiveManifest.Read(root, output); var project = Assert.Single(manifest.Projects);
            Assert.Contains("Example.cs", project.Sources); Assert.NotEmpty(project.Metadata!); Assert.NotEmpty(project.Inputs!);
            var database = new IndexDatabase(Path.Combine(root, "data", "index.db")); database.Initialize(); var indexer = new RepositoryIndexer(database);
            var repository = indexer.Register(root, new(output)); indexer.Index(repository);
            using var connection = database.Open(readOnly: true); using var command = connection.CreateCommand(); command.CommandText = "SELECT resolution FROM contexts";
            Assert.Equal("complete", command.ExecuteScalar());
            File.AppendAllText(Path.Combine(root, "Example.csproj"), "\n<!-- changed -->");
            Assert.Throws<IOException>(() => PassiveManifest.Read(root, output));
            indexer.Index(repository); Assert.Equal("syntaxOnly", command.ExecuteScalar());
            File.Delete(Path.Combine(root, "Example.cs")); indexer.Index(repository);
            command.CommandText = "SELECT count(*) FROM symbols"; Assert.Equal(0L, command.ExecuteScalar());
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
