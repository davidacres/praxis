using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Embeddings;
using Praxis.CodeIntelligence.Federation;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Interop;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class AnnAndInteropTests
{
    [Fact]
    public void ExactAndAnnVectorBackendSwitchingAndPruningEvaluation()
    {
        Assert.Equal("exact-simd", ModelStore.DefaultBackend.BackendName);

        var annBackend = new AnnEvaluationBackend
        {
            ClusterPruningFraction = 0.5
        };
        Assert.Equal("ann-partitioned-eval", annBackend.BackendName);

        var tempDir = Path.Combine(Path.GetTempPath(), "praxis-ann-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        var dbPath = Path.Combine(tempDir, "index.db");
        var modelDir = Path.Combine(tempDir, "models");
        Directory.CreateDirectory(modelDir);
        try
        {
            var database = new IndexDatabase(dbPath);
            database.Initialize();
            using var modelStore = new ModelStore(database, modelDir);
            Assert.Same(ModelStore.DefaultBackend, modelStore.VectorBackend);

            modelStore.VectorBackend = annBackend;
            Assert.Same(annBackend, modelStore.VectorBackend);

            // Execute an empty repository query through QueryService with the ANN backend
            var queries = new QueryService(database, modelStore);
            using var connection = database.Open();
            connection.Execute(null, "INSERT INTO repositories(repository_id, canonical_root, path_policy, structural_generation, query_epoch, desired_revision, state, config_json) VALUES('repo-test', '/test', 'caseSensitive', 1, 1, 1, 'indexed', '{}')");

            var dummyVector = new float[384];
            dummyVector[0] = 1.0f;
            var filter = new VectorSearchFilter(MaximumChunks: 1000);
            var query = new ModelQuery("sha256:" + new string('a', 64), dummyVector);

            using var transaction = connection.BeginTransaction();
            var candidates = annBackend.FindCandidates(connection, transaction, "repo-test", query, filter);
            Assert.Empty(candidates);
            Assert.NotNull(annBackend.LastMetrics);
            Assert.Equal(0, annBackend.LastMetrics.TotalCandidatesEvaluated);
        }
        finally
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, recursive: true);
        }
    }

    [Fact]
    public void ScipSymbolRoundTripAndFormatting()
    {
        var original = new ScipSymbol(
            Scheme: "scip-dotnet",
            PackageManager: "nuget",
            PackageName: "Newtonsoft.Json",
            Version: "13.0.1",
            Descriptors:
            [
                new ScipDescriptor("Newtonsoft", ScipDescriptorKind.Namespace),
                new ScipDescriptor("Json", ScipDescriptorKind.Namespace),
                new ScipDescriptor("JsonConvert", ScipDescriptorKind.Type),
                new ScipDescriptor("DeserializeObject", ScipDescriptorKind.Method, "v1")
            ]
        );

        var formatted = ScipInterop.Format(original);
        Assert.Equal("scip-dotnet nuget Newtonsoft.Json 13.0.1 Newtonsoft/Json/JsonConvert#DeserializeObject(v1).", formatted);

        var parsed = ScipInterop.Parse(formatted);
        Assert.Equal(original.Scheme, parsed.Scheme);
        Assert.Equal(original.PackageManager, parsed.PackageManager);
        Assert.Equal(original.PackageName, parsed.PackageName);
        Assert.Equal(original.Version, parsed.Version);
        Assert.Equal(4, parsed.Descriptors.Count);
        Assert.Equal("Newtonsoft", parsed.Descriptors[0].Name);
        Assert.Equal(ScipDescriptorKind.Namespace, parsed.Descriptors[0].Kind);
        Assert.Equal("JsonConvert", parsed.Descriptors[2].Name);
        Assert.Equal(ScipDescriptorKind.Type, parsed.Descriptors[2].Kind);
        Assert.Equal("DeserializeObject", parsed.Descriptors[3].Name);
        Assert.Equal(ScipDescriptorKind.Method, parsed.Descriptors[3].Kind);
        Assert.Equal("v1", parsed.Descriptors[3].Disambiguator);
    }

    [Fact]
    public void ScipSymbolMappingFromIndexedSymbol()
    {
        var indexed = new IndexedSymbol(
            Id: "pci:sym:repo:ctx:TestClass.TestMethod",
            Identity: "M:MyOrg.MyProject.TestClass.TestMethod",
            ContextId: "ctx-csharp-1",
            Kind: "method",
            Name: "TestMethod",
            QualifiedName: "MyOrg.MyProject.TestClass.TestMethod",
            Signature: "public void TestMethod()",
            Revision: "rev1",
            Resolution: "compiler",
            ContainerId: null,
            External: false,
            Documentation: "Documentation",
            Locations: []
        );

        var scip = ScipInterop.ToScipSymbol(indexed, "local", "MyProject", "1.0.0");
        Assert.Equal("scip-dotnet", scip.Scheme);
        Assert.Equal("local", scip.PackageManager);
        Assert.Equal("MyProject", scip.PackageName);
        Assert.Equal(4, scip.Descriptors.Count);
        Assert.Equal("MyOrg", scip.Descriptors[0].Name);
        Assert.Equal(ScipDescriptorKind.Namespace, scip.Descriptors[0].Kind);
        Assert.Equal("TestMethod", scip.Descriptors[3].Name);
        Assert.Equal(ScipDescriptorKind.Method, scip.Descriptors[3].Kind);

        var formatted = ScipInterop.Format(scip);
        Assert.Equal("scip-dotnet local MyProject 1.0.0 MyOrg/MyProject/TestClass/TestMethod().", formatted);
    }

    [Fact]
    public void InterRepositoryMappingEnforcesCommitHashPinning()
    {
        var registry = new InterRepositoryMappingRegistry();
        Assert.Equal(0, registry.Count);

        var mapping = new InterRepositoryMapping(
            SourceRepositoryId: "repo-source",
            TargetRepositoryId: "repo-target",
            SourceSymbolId: "pci:sym:source:caller",
            TargetSymbolId: "pci:sym:target:callee",
            TargetCommitHash: "c0ffee1234567890abcdef",
            VerifiedUtc: DateTimeOffset.UtcNow
        );

        registry.Register(mapping);
        Assert.Equal(1, registry.Count);

        // Resolving with matching target commit hash succeeds
        var resolved = registry.TryResolve("repo-source", "pci:sym:source:caller", "repo-target", "c0ffee1234567890abcdef", out var found);
        Assert.True(resolved);
        Assert.NotNull(found);
        Assert.Equal("pci:sym:target:callee", found.TargetSymbolId);

        // Resolving with mismatched target commit hash fails
        var rejected = registry.TryResolve("repo-source", "pci:sym:source:caller", "repo-target", "deadbeef99999999999999", out var notFound);
        Assert.False(rejected);
        Assert.Null(notFound);

        // Unregistered resolution fails
        var unmapped = registry.TryResolve("repo-other", "pci:sym:unknown", "repo-target", "c0ffee1234567890abcdef", out _);
        Assert.False(unmapped);
    }
}
