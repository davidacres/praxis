using System.Net;
using System.Security;
using System.Text.Json;
using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Enrichment;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class EnrichmentTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "praxis-enrichment-tests-" + Guid.NewGuid().ToString("N"));
    private readonly IndexDatabase database;
    private readonly RepositoryIndexer indexer;
    private readonly string repository;

    public EnrichmentTests()
    {
        Directory.CreateDirectory(root);
        database = new(Path.Combine(root, "data", "index.db"));
        database.Initialize();
        File.WriteAllText(Path.Combine(root, "Calculator.cs"),
            "namespace MathApp;\npublic class Calculator {\n    public int Add(int a, int b) => a + b;\n    public int Multiply(int a, int b) => a * b;\n}");
        var metadata = typeof(object).Assembly.Location;
        File.WriteAllText(Path.Combine(root, "context.praxis.json"), JsonSerializer.Serialize(new PassiveManifest(1,
            [new("project", "Project", ["Calculator.cs"], Metadata: [new(metadata, SourceFiles.Hash(File.ReadAllBytes(metadata)))])])));
        indexer = new(database);
        repository = indexer.Register(root, new("context.praxis.json"));
        indexer.Index(repository);
    }

    [Fact]
    public void LoopbackSecurityAllowsOnlyValidatedLoopbackEndpoints()
    {
        // Valid loopback endpoints
        LoopbackSecurity.ValidateLoopbackUri(new Uri("http://127.0.0.1:11434"));
        LoopbackSecurity.ValidateLoopbackUri(new Uri("http://127.0.0.1:8000/v1/chat/completions"));
        LoopbackSecurity.ValidateLoopbackUri(new Uri("http://[::1]:11434"));
        LoopbackSecurity.ValidateLoopbackUri(new Uri("http://localhost:5000/v1"));

        // External / non-loopback destinations MUST throw SecurityException
        Assert.Throws<SecurityException>(() => LoopbackSecurity.ValidateLoopbackUri(new Uri("http://192.168.1.50:8000")));
        Assert.Throws<SecurityException>(() => LoopbackSecurity.ValidateLoopbackUri(new Uri("http://10.0.0.1:11434")));
        Assert.Throws<SecurityException>(() => LoopbackSecurity.ValidateLoopbackUri(new Uri("https://api.openai.com/v1")));
        Assert.Throws<SecurityException>(() => LoopbackSecurity.ValidateLoopbackUri(new Uri("http://8.8.8.8:8080")));

        // Secure handler disables auto-redirects and proxies
        using var handler = LoopbackSecurity.CreateSecureLoopbackHandler();
        Assert.False(handler.AllowAutoRedirect);
        Assert.False(handler.UseProxy);
    }

    [Fact]
    public void StructuredOutputValidatorEnforcesSchemaAndRejectsFabricatedEvidence()
    {
        var allowedEvidence = new HashSet<string> { "pci:loc:1", "pci:loc:2" };

        // Valid output
        var validJson = JsonSerializer.Serialize(new
        {
            intent = "Adds two integers together and returns the sum.",
            inputs = new[] { "int a: first addend", "int b: second addend" },
            outputs = new[] { "int: arithmetic sum" },
            sideEffects = new[] { "none" },
            uncertainties = new[] { "none" },
            evidenceIds = new[] { "pci:loc:1" }
        });

        var result = EnrichmentValidator.Validate(validJson, allowedEvidence);
        Assert.Contains("Intent: Adds two integers", result.FormattedText);
        Assert.Single(result.ValidEvidenceIds);
        Assert.Equal("pci:loc:1", result.ValidEvidenceIds[0]);

        // Missing intent throws
        var missingIntent = JsonSerializer.Serialize(new
        {
            inputs = new[] { "a", "b" },
            outputs = new[] { "sum" },
            evidenceIds = new[] { "pci:loc:1" }
        });
        Assert.Throws<GroundingException>(() => EnrichmentValidator.Validate(missingIntent, allowedEvidence));

        // Missing evidenceIds throws
        var missingEvidence = JsonSerializer.Serialize(new
        {
            intent = "Compute",
            inputs = new[] { "a" },
            outputs = new[] { "res" }
        });
        Assert.Throws<GroundingException>(() => EnrichmentValidator.Validate(missingEvidence, allowedEvidence));

        // Fabricated evidence reference throws
        var fabricatedEvidenceJson = JsonSerializer.Serialize(new
        {
            intent = "Adds two integers together.",
            inputs = new[] { "a", "b" },
            outputs = new[] { "sum" },
            sideEffects = new[] { "none" },
            uncertainties = new string[0],
            evidenceIds = new[] { "pci:loc:1", "pci:loc:FABRICATED_999" }
        });
        var ex = Assert.Throws<GroundingException>(() => EnrichmentValidator.Validate(fabricatedEvidenceJson, allowedEvidence));
        Assert.Contains("Fabricated evidence reference cited", ex.Message);
    }

    [Fact]
    public void ExplainSymbolUsesGeneratedGroundedDescriptionWhenEnabledAndCachesResult()
    {
        var queriesBaseline = new QueryService(database);
        var findRes = queriesBaseline.Execute("find_symbol", new JsonObject
        {
            ["repositoryId"] = repository,
            ["name"] = "Add"
        }, new HashSet<string> { repository });

        var symbol = findRes["data"]!["items"]![0]!.AsObject();
        var symbolId = symbol["symbolId"]!.GetValue<string>();
        var declarationId = symbol["declarations"]![0]!.GetValue<string>();

        // 1. Without includeGenerated, returns deterministic compiler description
        var explainBaseline = queriesBaseline.Execute("explain_symbol", new JsonObject
        {
            ["repositoryId"] = repository,
            ["symbolId"] = symbolId,
            ["includeGenerated"] = false
        }, new HashSet<string> { repository });

        Assert.Equal("compiler", explainBaseline["data"]!["description"]!["provenance"]!.GetValue<string>());

        // 2. With mock LLM and includeGenerated = true
        var mockLlm = new MockLlmClient(prompt =>
        {
            return JsonSerializer.Serialize(new
            {
                intent = "Calculates the arithmetic sum of operands a and b.",
                inputs = new[] { "operand a", "operand b" },
                outputs = new[] { "sum of a and b" },
                sideEffects = new[] { "pure mathematical operation without side effects" },
                uncertainties = new[] { "overflow behavior depends on checked context" },
                evidenceIds = new[] { declarationId }
            });
        });

        var enrichment = new EnrichmentService(mockLlm);
        var queriesEnriched = new QueryService(database, null, enrichment);

        var explainGenerated = queriesEnriched.Execute("explain_symbol", new JsonObject
        {
            ["repositoryId"] = repository,
            ["symbolId"] = symbolId,
            ["includeGenerated"] = true
        }, new HashSet<string> { repository });

        var desc = explainGenerated["data"]!["description"]!.AsObject();
        Assert.Equal("generated", desc["provenance"]!.GetValue<string>());
        Assert.Equal("ready", desc["state"]!.GetValue<string>());
        Assert.Contains("Calculates the arithmetic sum", desc["text"]!.GetValue<string>());
        Assert.Equal(1, mockLlm.CallCount);

        // 3. Second call uses cached ready description from SQLite descriptions table
        var explainCached = queriesEnriched.Execute("explain_symbol", new JsonObject
        {
            ["repositoryId"] = repository,
            ["symbolId"] = symbolId,
            ["includeGenerated"] = true
        }, new HashSet<string> { repository });

        Assert.Equal("generated", explainCached["data"]!["description"]!["provenance"]!.GetValue<string>());
        Assert.Equal(1, mockLlm.CallCount); // Still 1: cache hit!
    }

    [Fact]
    public void SummarizeProjectGeneratesAggregateDescriptionWhenEnabled()
    {
        var queriesBaseline = new QueryService(database);
        string projectId;
        using (var conn = database.Open())
        {
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT project_id FROM projects WHERE repository_id = $0";
            cmd.Parameters.AddWithValue("$0", repository);
            projectId = (string)cmd.ExecuteScalar()!;
        }

        // Without includeGenerated: description is null
        var sumBaseline = queriesBaseline.Execute("summarize_project", new JsonObject
        {
            ["repositoryId"] = repository,
            ["projectId"] = projectId,
            ["includeGenerated"] = false
        }, new HashSet<string> { repository });

        Assert.Null(sumBaseline["data"]!["description"]);

        // With enrichment enabled and includeGenerated:
        var mockLlm = new MockLlmClient(prompt =>
        {
            return JsonSerializer.Serialize(new
            {
                intent = "Provides core mathematical calculation utilities including addition and multiplication.",
                inputs = new[] { "integer numbers" },
                outputs = new[] { "computed results" },
                sideEffects = new[] { "none" },
                uncertainties = new string[0],
                evidenceIds = new string[0]
            });
        });

        var enrichment = new EnrichmentService(mockLlm);
        var queriesEnriched = new QueryService(database, null, enrichment);

        var sumEnriched = queriesEnriched.Execute("summarize_project", new JsonObject
        {
            ["repositoryId"] = repository,
            ["projectId"] = projectId,
            ["includeGenerated"] = true
        }, new HashSet<string> { repository });

        var desc = sumEnriched["data"]!["description"];
        Assert.NotNull(desc);
        Assert.Equal("generated", desc["provenance"]!.GetValue<string>());
        Assert.Equal("ready", desc["state"]!.GetValue<string>());
        Assert.Contains("Provides core mathematical calculation utilities", desc["text"]!.GetValue<string>());
    }

    [Fact]
    public void StaleDependencyInvalidationMarksCachedDescriptionStale()
    {
        var queriesBaseline = new QueryService(database);
        var findRes = queriesBaseline.Execute("find_symbol", new JsonObject
        {
            ["repositoryId"] = repository,
            ["name"] = "Multiply"
        }, new HashSet<string> { repository });

        var symbol = findRes["data"]!["items"]![0]!.AsObject();
        var symbolId = symbol["symbolId"]!.GetValue<string>();
        var declarationId = symbol["declarations"]![0]!.GetValue<string>();

        var mockLlm = new MockLlmClient(prompt =>
        {
            return JsonSerializer.Serialize(new
            {
                intent = "Multiplies two integers.",
                inputs = new[] { "a", "b" },
                outputs = new[] { "product" },
                sideEffects = new[] { "none" },
                uncertainties = new string[0],
                evidenceIds = new[] { declarationId }
            });
        });

        var enrichment = new EnrichmentService(mockLlm);
        var queriesEnriched = new QueryService(database, null, enrichment);

        var initial = queriesEnriched.Execute("explain_symbol", new JsonObject
        {
            ["repositoryId"] = repository,
            ["symbolId"] = symbolId,
            ["includeGenerated"] = true
        }, new HashSet<string> { repository });

        Assert.Equal(1, mockLlm.CallCount);

        // Explicitly invalidate symbol
        using (var connection = database.Open())
        {
            EnrichmentService.InvalidateSymbol(connection, null, symbolId);
        }

        // Verify state is marked stale in DB
        using (var connection = database.Open())
        using (var cmd = connection.CreateCommand())
        {
            cmd.CommandText = "SELECT state FROM descriptions WHERE symbol_id = $0 AND kind = 'generated'";
            cmd.Parameters.AddWithValue("$0", symbolId);
            var state = (string?)cmd.ExecuteScalar();
            Assert.Equal("stale", state);
        }

        // Subsequent query re-generates since cached entry is stale
        var regenerated = queriesEnriched.Execute("explain_symbol", new JsonObject
        {
            ["repositoryId"] = repository,
            ["symbolId"] = symbolId,
            ["includeGenerated"] = true
        }, new HashSet<string> { repository });

        Assert.Equal(2, mockLlm.CallCount);
        Assert.Equal("ready", regenerated["data"]!["description"]!["state"]!.GetValue<string>());
    }

    private sealed class MockLlmClient(Func<string, string> responder) : ILocalLlmClient
    {
        public bool IsEnabled => true;
        public string Model => "mock-model-v1";
        public int CallCount { get; private set; }

        public Task<string> CompleteAsync(string systemPrompt, string userPrompt, CancellationToken cancellationToken)
        {
            CallCount++;
            return Task.FromResult(responder(userPrompt));
        }
    }

    public void Dispose()
    {
        try { Directory.Delete(root, recursive: true); } catch { }
    }
}
