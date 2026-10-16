using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

// Inference's reference-pack roots are process-wide; never run these alongside others.
[CollectionDefinition(nameof(ProjectInferenceTests), DisableParallelization = true)]
public sealed class ProjectInferenceCollection;

[Collection(nameof(ProjectInferenceTests))]
public sealed class ProjectInferenceTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "pci-inference-" + Guid.NewGuid().ToString("N"));
    private readonly Func<IEnumerable<string>> originalRoots = ProjectInference.DotnetRoots;
    public ProjectInferenceTests()
    {
        Directory.CreateDirectory(root);
        // Deterministic on every host: no installed reference packs, so inference uses
        // this process's runtime assemblies as framework references.
        ProjectInference.DotnetRoots = () => [];
    }
    public void Dispose() { ProjectInference.DotnetRoots = originalRoots; Directory.Delete(root, recursive: true); }

    private void Write(string relative, string text)
    {
        var path = Path.Combine(root, relative); Directory.CreateDirectory(Path.GetDirectoryName(path)!); File.WriteAllText(path, text);
    }
    private (IndexDatabase Database, string Repository, Func<string, JsonObject, JsonObject> Query) Index()
    {
        var database = new IndexDatabase(Path.Combine(root, "..", Path.GetFileName(root) + "-data", "index.db")); database.Initialize();
        var indexer = new RepositoryIndexer(database); var repository = indexer.Register(root); indexer.Index(repository);
        var service = new QueryService(database);
        JsonObject Query(string tool, JsonObject arguments)
        {
            arguments["repositoryId"] = repository;
            var response = service.Execute(tool, arguments, new HashSet<string> { repository });
            Assert.Null(response["error"]); return response;
        }
        return (database, repository, Query);
    }

    [Fact]
    public void SdkProjectsWithoutRestoreOutputResolveAcrossProjectsWithImplicitUsings()
    {
        Write("Lib/Lib.csproj", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
            </Project>
            """);
        Write("Lib/Catalog.cs", "namespace Lib; public sealed class Catalog { private readonly List<string> names = []; public int Count(string prefix) => names.Count(name => name.StartsWith(prefix)); }");
        Write("App/App.csproj", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>
              <ItemGroup><ProjectReference Include="..\Lib\Lib.csproj" /></ItemGroup>
            </Project>
            """);
        Write("App/Program.cs", "namespace App; public static class Program { public static int Main() => new Lib.Catalog().Count(\"a\"); }");
        var (database, _, query) = Index();
        var status = query("get_index_status", new())["data"]!;
        var resolutions = status["contexts"]!.AsArray().Select(context => context!["resolution"]!.GetValue<string>()).Order().ToArray();
        Assert.Equal(["complete", "complete"], resolutions);
        var count = query("find_symbol", new() { ["name"] = "Count" })["data"]!["items"]![0]!["symbolId"]!.GetValue<string>();
        var callers = query("get_callers", new() { ["symbolId"] = count })["data"]!["items"]!.AsArray();
        Assert.Single(callers);
        Assert.Empty(database.Check());
    }

    [Fact]
    public void RestoreOutputSuppliesPackageReferencesAndGeneratedUsingsStaySupportOnly()
    {
        var package = typeof(FactAttribute).Assembly.Location; var fileName = Path.GetFileName(package);
        var packages = Path.Combine(root, "..", Path.GetFileName(root) + "-packages") + Path.DirectorySeparatorChar;
        Directory.CreateDirectory(Path.Combine(packages, "fixture.package", "1.0.0", "lib", "net10.0"));
        File.Copy(package, Path.Combine(packages, "fixture.package", "1.0.0", "lib", "net10.0", fileName));
        try
        {
            Write("Tests/Tests.csproj", """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup>
                  <ItemGroup><PackageReference Include="Fixture.Package" Version="1.0.0" /></ItemGroup>
                </Project>
                """);
            Write("Tests/obj/project.assets.json", new JsonObject
            {
                ["version"] = 3,
                ["targets"] = new JsonObject { ["net10.0"] = new JsonObject { ["Fixture.Package/1.0.0"] = new JsonObject {
                    ["type"] = "package", ["compile"] = new JsonObject { ["lib/net10.0/" + fileName] = new JsonObject(), ["lib/net10.0/_._"] = new JsonObject() } } } },
                ["libraries"] = new JsonObject { ["Fixture.Package/1.0.0"] = new JsonObject { ["path"] = "fixture.package/1.0.0" } },
                ["packageFolders"] = new JsonObject { [packages] = new JsonObject() },
                ["project"] = new JsonObject { ["frameworks"] = new JsonObject { ["net10.0"] = new JsonObject() } }
            }.ToJsonString());
            // The SDK's own generated usings, including one only it would know about.
            Write("Tests/obj/Debug/net10.0/Tests.GlobalUsings.g.cs", "global using global::System;\nglobal using global::System.Linq;\nglobal using global::Xunit;\n");
            Write("Tests/CatalogTests.cs", "namespace Tests; public sealed class CatalogTests { [Fact] public void Counts() { _ = new[] { 1 }.Any(); } }");
            var (database, _, query) = Index();
            var status = query("get_index_status", new())["data"]!;
            Assert.Equal("complete", status["contexts"]![0]!["resolution"]!.GetValue<string>());
            Assert.DoesNotContain(status["diagnostics"]!.AsArray(), diagnostic => diagnostic!["code"]!.GetValue<string>() is "CS0246" or "PACKAGES_NOT_RESTORED");
            // The generated file informs the compiler but is never searchable authored code.
            using var read = database.Open(readOnly: true); using var command = read.CreateCommand();
            command.CommandText = "SELECT role FROM files WHERE relative_path LIKE '%GlobalUsings.g.cs'";
            Assert.Equal("semanticSupport", command.ExecuteScalar());
        }
        finally { Directory.Delete(packages, recursive: true); }
    }

    [Fact]
    public void ProjectReferencesFlowTransitivelyUnlessAProjectOptsOut()
    {
        string Project(string reference, bool direct = false) => $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework>{(direct ? "<DisableTransitiveProjectReferences>true</DisableTransitiveProjectReferences>" : "")}</PropertyGroup>
              <ItemGroup>{reference}</ItemGroup>
            </Project>
            """;
        Write("A/A.csproj", Project(""));
        Write("A/Model.cs", "namespace A; public sealed class Model { }");
        Write("B/B.csproj", Project("<ProjectReference Include=\"..\\A\\A.csproj\" />"));
        Write("B/Service.cs", "namespace B; public sealed class Service { public A.Model Create() => new(); }");
        Write("C/C.csproj", Project("<ProjectReference Include=\"..\\B\\B.csproj\" />"));
        Write("C/Consumer.cs", "namespace C; public static class Consumer { public static A.Model Use() => new B.Service().Create(); }");
        Write("D/D.csproj", Project("<ProjectReference Include=\"..\\B\\B.csproj\" />", direct: true));
        Write("D/Consumer.cs", "namespace D; public static class Consumer { public static A.Model Use() => new B.Service().Create(); }");
        var (_, _, query) = Index();
        var status = query("get_index_status", new())["data"]!;
        Assert.Equal(["complete", "complete", "complete", "partial"], status["contexts"]!.AsArray().Select(context => context!["resolution"]!.GetValue<string>()).Order().ToArray());
        Assert.Contains(status["diagnostics"]!.AsArray(), diagnostic => diagnostic!["code"]!.GetValue<string>() == "CS0246");
    }

    [Fact]
    public void InferenceNeverExecutesProjectTargets()
    {
        var marker = Path.Combine(root, "executed.txt");
        Write("Lib/Lib.csproj", $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
              <Target Name="Side" BeforeTargets="ResolveReferences;Restore;Build"><WriteLinesToFile File="{marker}" Lines="ran" /></Target>
            </Project>
            """);
        Write("Lib/Value.cs", "namespace Lib; public static class Value { public static int Get() => 1; }");
        var (_, _, query) = Index();
        Assert.Equal("complete", query("get_index_status", new())["data"]!["contexts"]![0]!["resolution"]!.GetValue<string>());
        Assert.False(File.Exists(marker));
    }

    [Fact]
    public void MalformedProjectXmlDegradesToSyntaxOnlyWithADiagnostic()
    {
        Write("Lib/Lib.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup>");
        Write("Lib/Value.cs", "namespace Lib; public static class Value { public static int Get() => 1; }");
        var (database, _, query) = Index();
        var status = query("get_index_status", new())["data"]!;
        Assert.Equal("syntaxOnly", status["contexts"]![0]!["resolution"]!.GetValue<string>());
        Assert.Contains(status["diagnostics"]!.AsArray(), diagnostic => diagnostic!["code"]!.GetValue<string>() == "PROJECT_INFERENCE_FAILED");
        Assert.NotEmpty(query("find_symbol", new() { ["name"] = "Get" })["data"]!["items"]!.AsArray());
        Assert.Empty(database.Check());
    }
}
