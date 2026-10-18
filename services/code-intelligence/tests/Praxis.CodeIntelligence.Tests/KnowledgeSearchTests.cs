using System.Text.Json;
using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class KnowledgeSearchTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "praxis-knowledge-tests-" + Guid.NewGuid().ToString("N"));
    private readonly IndexDatabase database;
    private readonly RepositoryIndexer indexer;
    private readonly QueryService queries;
    private readonly string repository;

    public KnowledgeSearchTests()
    {
        Directory.CreateDirectory(root);
        database = new(Path.Combine(root, "data", "index.db"));
        database.Initialize();

        // Create a C# source file
        File.WriteAllText(Path.Combine(root, "Example.cs"), "namespace ExampleApp;\npublic class OrderService { public void ProcessOrder() {} }");

        // Create markdown documentation files
        var docsDir = Path.Combine(root, "docs");
        Directory.CreateDirectory(docsDir);
        File.WriteAllText(Path.Combine(docsDir, "architecture.md"), """
            ---
            title: System Architecture
            status: approved
            ---
            # System Architecture
            The system processes customer orders and coordinates warehouse logistics.

            ## Order Processing
            The OrderService manages the lifecycle of customer orders from creation to fulfillment.

            ## Warehouse Logistics
            Logistics handles dispatch and inventory tracking across all fulfillment centers.
            """);

        var specsDir = Path.Combine(root, "specs");
        Directory.CreateDirectory(specsDir);
        File.WriteAllText(Path.Combine(specsDir, "billing.md"), """
            # Billing Specification
            Payment gateway integration and invoicing details.

            ## Subscriptions
            Recurring subscription billing rules and invoice generation.
            """);

        // Create a CSV sheet
        var dataDir = Path.Combine(root, "data");
        Directory.CreateDirectory(dataDir);
        File.WriteAllText(Path.Combine(dataDir, "metrics.csv"), "Metric,Value\nRevenue,1000000\nOrders,5000\n");

        var metadata = typeof(object).Assembly.Location;
        File.WriteAllText(Path.Combine(root, "context.praxis.json"), JsonSerializer.Serialize(new PassiveManifest(1,
            [new("project", "Project", ["Example.cs"], Metadata: [new(metadata, SourceFiles.Hash(File.ReadAllBytes(metadata)))])])));

        indexer = new(database);
        repository = indexer.Register(root, new("context.praxis.json"));
        indexer.Index(repository);
        queries = new(database);
    }

    private JsonObject Query(string tool, JsonObject? input = null)
    {
        input ??= new();
        input["repositoryId"] = repository;
        if (!input.ContainsKey("responseBudgetTokens")) input["responseBudgetTokens"] = 8000;
        var response = queries.Execute(tool, input, new HashSet<string> { repository });
        // CI validates every captured response against the tool's normative schema.
        var directory = Environment.GetEnvironmentVariable("PRAXIS_CONTRACT_SAMPLES");
        if (directory is not null) { Directory.CreateDirectory(directory); File.WriteAllText(Path.Combine(directory, tool + "-" + Guid.NewGuid() + ".json"), response.ToJsonString()); }
        return response;
    }

    [Fact]
    public void Indexing_MarkdownAndCsv_StoresDocumentsAndSections()
    {
        using var connection = database.Open(readOnly: true);
        var docCount = Convert.ToInt64(connection.Scalar(null, "SELECT count(*) FROM documents WHERE repository_id = $0", repository));
        Assert.True(docCount >= 3, $"Expected at least 3 documents, got {docCount}");

        var sectionCount = Convert.ToInt64(connection.Scalar(null, """
            SELECT count(*) FROM knowledge_sections s
            JOIN documents d ON d.document_id = s.document_id
            WHERE d.repository_id = $0
            """, repository));
        Assert.True(sectionCount >= 4, $"Expected at least 4 sections, got {sectionCount}");

        // Verify FTS trigger populated knowledge_fts
        var ftsCount = Convert.ToInt64(connection.Scalar(null, "SELECT count(*) FROM knowledge_fts"));
        Assert.Equal(sectionCount, ftsCount);
    }

    [Fact]
    public void SearchKnowledge_Lexical_FindsMatchingSections()
    {
        var response = Query("search_knowledge", new()
        {
            ["query"] = "warehouse logistics",
            ["mode"] = "lexical"
        });

        Assert.Null(response["error"]);
        var matches = response["data"]!["matches"]!.AsArray();
        Assert.NotEmpty(matches);

        var first = matches[0]!.AsObject();
        Assert.NotNull(first["sectionId"]?.GetValue<string>());
        Assert.Equal("docs/architecture.md", first["path"]?.GetValue<string>());
        Assert.Equal("Warehouse Logistics", first["heading"]?.GetValue<string>());
        Assert.Contains("Logistics handles dispatch", first["body"]?.GetValue<string>());
        Assert.True(first["score"]?.GetValue<double>() > 0);
    }

    [Fact]
    public void SearchKnowledge_Filters_ByDocTypeAndPathPrefix()
    {
        // 1. Filter by docTypes: markdown
        var responseMd = Query("search_knowledge", new()
        {
            ["query"] = "revenue orders",
            ["mode"] = "lexical",
            ["filters"] = new JsonObject
            {
                ["docTypes"] = new JsonArray { "markdown" }
            }
        });
        Assert.Null(responseMd["error"]);
        var mdMatches = responseMd["data"]!["matches"]!.AsArray();
        Assert.All(mdMatches, m => Assert.EndsWith(".md", m!["path"]!.GetValue<string>()));

        // 2. Filter by pathPrefix: specs/
        var responseSpecs = Query("search_knowledge", new()
        {
            ["query"] = "billing subscription",
            ["mode"] = "lexical",
            ["filters"] = new JsonObject
            {
                ["pathPrefix"] = "specs"
            }
        });
        Assert.Null(responseSpecs["error"]);
        var specMatches = responseSpecs["data"]!["matches"]!.AsArray();
        Assert.NotEmpty(specMatches);
        Assert.All(specMatches, m => Assert.StartsWith("specs/", m!["path"]!.GetValue<string>()));
    }

    [Fact]
    public void GetKnowledgeSection_BySectionId()
    {
        // Search first to get a real sectionId
        var searchResp = Query("search_knowledge", new()
        {
            ["query"] = "billing",
            ["mode"] = "lexical"
        });
        var sectionId = searchResp["data"]!["matches"]![0]!["sectionId"]!.GetValue<string>();

        var response = Query("get_knowledge_section", new()
        {
            ["sectionId"] = sectionId
        });

        Assert.Null(response["error"]);
        var data = response["data"]!.AsObject();
        Assert.Equal(sectionId, data["sectionId"]?.GetValue<string>());
        Assert.Equal("specs/billing.md", data["path"]?.GetValue<string>());
        Assert.Equal("markdown", data["docType"]?.GetValue<string>());
    }

    [Fact]
    public void GetKnowledgeSection_ByPathAndHeading()
    {
        var response = Query("get_knowledge_section", new()
        {
            ["path"] = "docs/architecture.md",
            ["heading"] = "Order Processing"
        });

        Assert.Null(response["error"]);
        var data = response["data"]!.AsObject();
        Assert.Equal("docs/architecture.md", data["path"]?.GetValue<string>());
        Assert.Equal("Order Processing", data["heading"]?.GetValue<string>());
        Assert.Contains("OrderService", data["body"]?.GetValue<string>());
        Assert.NotNull(data["frontmatter"]);
    }

    [Fact]
    public void GetKnowledgeSection_NotFound_ReturnsSectionNotFound()
    {
        var response = Query("get_knowledge_section", new()
        {
            ["sectionId"] = "nonexistent-section-id"
        });

        Assert.NotNull(response["error"]);
        Assert.Equal("SECTION_NOT_FOUND", response["error"]!["code"]?.GetValue<string>());
    }

    [Fact]
    public void FindRelatedKnowledge_WithDirectLinks()
    {
        // Insert a direct link from a knowledge section to the OrderService symbol
        using var connection = database.Open();
        var symbolId = connection.Scalar(null, "SELECT symbol_id FROM symbols WHERE name = 'OrderService'") as string;
        Assert.NotNull(symbolId);

        var sectionId = connection.Scalar(null, """
            SELECT s.section_id FROM knowledge_sections s
            JOIN documents d ON d.document_id = s.document_id
            WHERE s.heading = 'Order Processing'
            """) as string;
        Assert.NotNull(sectionId);

        connection.Execute(null, """
            INSERT INTO knowledge_links(link_id, section_id, target_kind, target_symbol_id, target_key, provenance)
            VALUES('link1', $0, 'symbol', $1, $1, 'symbol_match')
            """, sectionId, symbolId);

        var response = Query("find_related_knowledge", new()
        {
            ["symbolId"] = symbolId
        });

        Assert.Null(response["error"]);
        var items = response["data"]!["items"]!.AsArray();
        Assert.NotEmpty(items);

        var linked = items[0]!.AsObject();
        Assert.Equal(sectionId, linked["sectionId"]?.GetValue<string>());
        Assert.Equal("symbol_match", linked["provenance"]?.GetValue<string>());
        Assert.Equal("symbol", linked["targetKind"]?.GetValue<string>());
        Assert.Equal(1.0, linked["score"]?.GetValue<double>());
    }

    [Fact]
    public void FindRelatedKnowledge_FallbackSearch()
    {
        // Query by a path that has no explicit links - fallback search should find matching docs
        var response = Query("find_related_knowledge", new()
        {
            ["path"] = "specs/billing.md"
        });

        Assert.Null(response["error"]);
        var items = response["data"]!["items"]!.AsArray();
        Assert.NotEmpty(items);
        Assert.Contains(items, item => item!["path"]?.GetValue<string>() == "specs/billing.md");
    }

    [Fact]
    public void SearchKnowledge_HybridWithoutModel_DegradesWithWarning()
    {
        var response = Query("search_knowledge", new()
        {
            ["query"] = "architecture logistics",
            ["mode"] = "hybrid"
        });

        Assert.Null(response["error"]);
        Assert.NotEmpty(response["data"]!["matches"]!.AsArray());

        // Warnings should mention MODEL_UNAVAILABLE
        var warnings = response["warnings"]!.AsArray();
        Assert.Contains(warnings, w => w!["code"]?.GetValue<string>() == "MODEL_UNAVAILABLE");
    }

    [Fact]
    public void SearchKnowledge_VectorWithoutModel_FailsWithModelUnavailable()
    {
        var response = Query("search_knowledge", new()
        {
            ["query"] = "architecture logistics",
            ["mode"] = "vector"
        });

        Assert.NotNull(response["error"]);
        Assert.Equal("MODEL_UNAVAILABLE", response["error"]!["code"]?.GetValue<string>());
    }

    [Fact]
    public void SearchKnowledge_ExcessQueryTerms_Rejected()
    {
        var terms = string.Join(" ", Enumerable.Range(0, 70).Select(i => $"term{i}"));
        var response = Query("search_knowledge", new()
        {
            ["query"] = terms
        });

        Assert.NotNull(response["error"]);
        Assert.Equal("INVALID_ARGUMENT", response["error"]!["code"]?.GetValue<string>());
    }

    [Fact]
    public void IncrementalIndexing_UpdateDocument_ReindexesSectionsAndFts()
    {
        var docsDir = Path.Combine(root, "docs");
        File.WriteAllText(Path.Combine(docsDir, "architecture.md"), """
            # Super Quantum Architecture
            The quantum processing unit handles hyperdimensional state machines.
            """);

        indexer.Index(repository);

        var oldResp = Query("search_knowledge", new()
        {
            ["query"] = "warehouse logistics",
            ["mode"] = "lexical"
        });
        Assert.Empty(oldResp["data"]!["matches"]!.AsArray());

        var newResp = Query("search_knowledge", new()
        {
            ["query"] = "quantum hyperdimensional",
            ["mode"] = "lexical"
        });
        var matches = newResp["data"]!["matches"]!.AsArray();
        Assert.NotEmpty(matches);
        Assert.Equal("Super Quantum Architecture", matches[0]!["heading"]?.GetValue<string>());
    }

    public void Dispose()
    {
        try { Directory.Delete(root, true); } catch { }
    }
}
