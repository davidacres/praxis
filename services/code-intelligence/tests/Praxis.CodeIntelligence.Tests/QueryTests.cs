using System.Text.Json;
using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class QueryTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "praxis-query-tests-" + Guid.NewGuid().ToString("N"));
    private readonly IndexDatabase database;
    private readonly RepositoryIndexer indexer;
    private readonly QueryService queries;
    private readonly string repository;
    public QueryTests()
    {
        Directory.CreateDirectory(root); database = new(Path.Combine(root, "data", "index.db")); database.Initialize();
        File.WriteAllText(Path.Combine(root, "Example.cs"), "class Example { int Target(int value) => value; int Caller() => Target(2); void Overload(int x) {} void Overload(string x) {} }");
        var metadata = typeof(object).Assembly.Location;
        File.WriteAllText(Path.Combine(root, "context.praxis.json"), JsonSerializer.Serialize(new PassiveManifest(1,
            [new("project", "Project", ["Example.cs"], Metadata: [new(metadata, SourceFiles.Hash(File.ReadAllBytes(metadata)))])])));
        indexer = new(database); repository = indexer.Register(root, new("context.praxis.json")); indexer.Index(repository); queries = new(database);
    }
    private JsonObject Query(string tool, JsonObject? input = null)
    {
        input ??= new(); input["repositoryId"] = repository; if (!input.ContainsKey("responseBudgetTokens")) input["responseBudgetTokens"] = 8000;
        var response = queries.Execute(tool, input, new HashSet<string> { repository });
        var directory = Environment.GetEnvironmentVariable("PRAXIS_CONTRACT_SAMPLES");
        if (directory is not null) { Directory.CreateDirectory(directory); File.WriteAllText(Path.Combine(directory, tool + "-" + Guid.NewGuid() + ".json"), response.ToJsonString()); }
        return response;
    }
    private JsonObject Symbol(string name) => Query("find_symbol", new() { ["name"] = name })["data"]!["items"]![0]!.AsObject();

    [Fact]
    public void NormativeDefaultLimitsAndEmptyRelationFiltersAreApplied()
    {
        var types = string.Join(" ", Enumerable.Range(0, 15).Select(i => "class DefaultEntry" + i + " {}"));
        var overloads = string.Join(" ", Enumerable.Range(0, 12).Select(i => "void Target(" + string.Join(",", Enumerable.Range(0, i).Select(n => "int p" + n)) + ") {}"));
        File.WriteAllText(Path.Combine(root, "Example.cs"), types + " class Example { " + overloads + " void Caller() { Target(); } }"); indexer.Index(repository);
        var search = Query("search_code", new() { ["query"] = "Default", ["mode"] = "lexical", ["filters"] = new JsonObject { ["kinds"] = new JsonArray(), ["languages"] = new JsonArray(), ["projectIds"] = new JsonArray() } });
        Assert.Null(search["error"]); Assert.Equal(10, search["data"]!["matches"]!.AsArray().Count); Assert.NotNull(search["nextCursor"]);
        var unfilteredSearch = Query("search_code", new() { ["query"] = "Default", ["mode"] = "lexical" });
        Assert.Equal(unfilteredSearch["data"]!["eligibleSymbolCount"]!.GetValue<long>(), search["data"]!["eligibleSymbolCount"]!.GetValue<long>());
        Assert.True(search["data"]!["eligibleSymbolCount"]!.GetValue<long>() > 0);
        Assert.Equal(10, Query("find_symbol", new() { ["name"] = "Target" })["data"]!["items"]!.AsArray().Count);
        var caller = Symbol("Caller");
        var trace = Query("trace_flow", new() { ["symbolId"] = caller["symbolId"]!.DeepClone(), ["edgeKinds"] = new JsonArray() });
        Assert.Single(trace["data"]!["edges"]!.AsArray(), edge => edge!["kind"]!.GetValue<string>() == "calls"); Assert.Equal(2000, trace["data"]!["limitsApplied"]!["maxEdges"]!.GetValue<int>());
        var related = Query("find_related", new() { ["symbolId"] = caller["symbolId"]!.DeepClone(), ["kinds"] = new JsonArray() });
        var unfiltered = Query("find_related", new() { ["symbolId"] = caller["symbolId"]!.DeepClone() });
        Assert.Equal(unfiltered["data"]!["items"]!.AsArray().Count, related["data"]!["items"]!.AsArray().Count);
        Assert.True(related["data"]!["items"]!.AsArray().Count >= 2);
    }

    [Fact]
    public void FiltersNormalizeCaseWhitespaceAndRejectDuplicateValues()
    {
        var normalized = Query("search_code", new() { ["query"] = "Target", ["mode"] = "lexical", ["filters"] = new JsonObject { ["kinds"] = new JsonArray(" METHOD "), ["languages"] = new JsonArray(" CSHARP ") } });
        Assert.Null(normalized["error"]); Assert.NotEmpty(normalized["data"]!["matches"]!.AsArray());
        var duplicate = Query("search_code", new() { ["query"] = "Target", ["filters"] = new JsonObject { ["kinds"] = new JsonArray("method", " METHOD ") } });
        Assert.Equal("INVALID_ARGUMENT", duplicate["error"]!["code"]!.GetValue<string>());
        var duplicateEdges = Query("trace_flow", new() { ["symbolId"] = Symbol("Caller")["symbolId"]!.DeepClone(), ["edgeKinds"] = new JsonArray("calls", " CALLS ") });
        Assert.Equal("INVALID_ARGUMENT", duplicateEdges["error"]!["code"]!.GetValue<string>());
    }

    [Fact]
    public void OptionalGraphExpansionKeepsDirectMatchesFirstAndPreservesEdgeEvidence()
    {
        File.WriteAllText(Path.Combine(root, "Example.cs"), "class Example { int Related() => 1; int UniqueSeed() => Related(); }"); indexer.Index(repository);
        var direct = Query("search_code", new() { ["query"] = "UniqueSeed", ["mode"] = "lexical" });
        Assert.Single(direct["data"]!["matches"]!.AsArray());
        var expanded = Query("search_code", new() { ["query"] = "UniqueSeed", ["mode"] = "lexical", ["expandGraph"] = true });
        Assert.Null(expanded["error"]); var matches = expanded["data"]!["matches"]!.AsArray(); Assert.Equal(3, matches.Count);
        Assert.Equal("Example.UniqueSeed()", matches[0]!["symbol"]!["qualifiedName"]!.GetValue<string>());
        var related = Assert.Single(matches, match => match!["symbol"]!["qualifiedName"]!.GetValue<string>() == "Example.Related()")!;
        Assert.Contains(related["reasons"]!.AsArray(), reason => reason!.GetValue<string>() == "graph");
        Assert.Contains(expanded["data"]!["channelsUsed"]!.AsArray(), channel => channel!.GetValue<string>() == "graph");
        foreach (var evidenceId in related["evidenceIds"]!.AsArray())
            Assert.Contains(expanded["evidence"]!.AsArray(), evidence => evidence!["id"]!.GetValue<string>() == evidenceId!.GetValue<string>());
        Assert.Contains(expanded["evidence"]!.AsArray(), evidence => evidence!["id"]!.GetValue<string>().StartsWith("pci:occ:", StringComparison.Ordinal));
        var filtered = Query("search_code", new() { ["query"] = "UniqueSeed", ["mode"] = "lexical", ["expandGraph"] = true, ["filters"] = new JsonObject { ["kinds"] = new JsonArray("type") } });
        Assert.Empty(filtered["data"]!["matches"]!.AsArray());
    }

    [Fact]
    public void UnresolvedTraceOccurrencesCarrySourceEvidence()
    {
        File.WriteAllText(Path.Combine(root, "Example.cs"), "class Example { void Caller() { MissingTarget(); } }"); indexer.Index(repository);
        var caller = Symbol("Caller");
        var trace = Query("trace_flow", new() { ["symbolId"] = caller["symbolId"]!.DeepClone() }); Assert.Null(trace["error"]);
        var occurrence = Assert.Single(trace["data"]!["unresolvedOccurrences"]!.AsArray())!.GetValue<string>();
        var evidence = Assert.Single(trace["evidence"]!.AsArray(), item => item!["id"]!.GetValue<string>() == occurrence)!;
        Assert.Equal("unresolved", evidence["resolution"]!.GetValue<string>());
        Assert.Equal("Example.cs", evidence["path"]!.GetValue<string>()); Assert.NotNull(evidence["range"]);
    }

    [Fact]
    public void StatusAndProjectSummaryTrimLargeCollectionsWithHonestCoverage()
    {
        File.WriteAllText(Path.Combine(root, "Example.cs"), string.Join("\n", Enumerable.Range(0, 200).Select(i => "class Component" + i + " { Unknown" + i + " field; }"))); indexer.Index(repository);
        var status = Query("get_index_status", new() { ["responseBudgetTokens"] = 512 });
        Assert.Null(status["error"]); Assert.True(status["truncated"]!.GetValue<bool>()); Assert.Null(status["nextCursor"]);
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(status.ToJsonString()) <= 1536);
        Assert.Single(status["data"]!["contexts"]!.AsArray());
        using var read = database.Open(readOnly: true); using var command = read.CreateCommand(); command.CommandText = "SELECT project_id FROM projects";
        var summary = Query("summarize_project", new() { ["projectId"] = (string)command.ExecuteScalar()!, ["responseBudgetTokens"] = 1500 });
        Assert.Null(summary["error"]); Assert.True(summary["truncated"]!.GetValue<bool>()); Assert.Null(summary["nextCursor"]);
        Assert.InRange(summary["data"]!["components"]!.AsArray().Count, 1, 99);
        Assert.Equal(200, summary["data"]!["coverage"]!["eligible"]!.GetValue<int>());
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(summary.ToJsonString()) <= 4500);
    }

    [Fact]
    public void ExternalSymbolsHaveMetadataEvidenceAndNoInventedSourceDeclaration()
    {
        File.WriteAllText(Path.Combine(root, "Example.cs"), "class Example { bool Caller() => object.ReferenceEquals(null, null); }"); indexer.Index(repository);
        var external = Symbol("ReferenceEquals"); var id = external["symbolId"]!.GetValue<string>();
        Assert.True(external["external"]!.GetValue<bool>()); Assert.Null(external["contextId"]); Assert.Empty(external["declarations"]!.AsArray());
        var explained = Query("explain_symbol", new() { ["symbolId"] = id }); Assert.Null(explained["error"]);
        Assert.Equal("metadata", explained["data"]!["provenance"]!.GetValue<string>());
        var evidence = Assert.Single(explained["evidence"]!.AsArray());
        Assert.Equal("metadata", evidence!["provenance"]!.GetValue<string>());
        Assert.NotNull(evidence["referenceIdentity"]); Assert.Null(evidence["fileId"]);
        Assert.Contains(explained["data"]!["facts"]![0]!["evidenceIds"]!.AsArray(), value => value!.GetValue<string>() == evidence["id"]!.GetValue<string>());
        Assert.Equal("CAPABILITY_UNAVAILABLE", Query("get_source", new() { ["symbolId"] = id })["error"]!["code"]!.GetValue<string>());
    }

    [Fact]
    public void GraphBudgetTrimmingKeepsRootEndpointsAndEvidenceConsistent()
    {
        var methods = string.Join(" ", Enumerable.Range(0, 20).Select(i => "void Target" + i + "() {}"));
        var calls = string.Join(" ", Enumerable.Range(0, 20).Select(i => "Target" + i + "();"));
        File.WriteAllText(Path.Combine(root, "Example.cs"), "class Example { " + methods + " void Caller() { " + calls + " } }"); indexer.Index(repository);
        var caller = Symbol("Caller"); var id = caller["symbolId"]!.GetValue<string>();
        var response = Query("trace_flow", new() { ["symbolId"] = id, ["responseBudgetTokens"] = 2400 });
        Assert.Null(response["error"]); Assert.True(response["truncated"]!.GetValue<bool>()); Assert.Null(response["nextCursor"]);
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(response.ToJsonString()) <= 7200);
        var nodes = response["data"]!["nodes"]!.AsArray().Select(n => n!["symbolId"]!.GetValue<string>()).ToHashSet();
        Assert.Contains(id, nodes); Assert.True(nodes.Count < 21);
        foreach (var edge in response["data"]!["edges"]!.AsArray())
        {
            Assert.Contains(edge!["sourceSymbolId"]!.GetValue<string>(), nodes); Assert.Contains(edge["targetSymbolId"]!.GetValue<string>(), nodes);
            foreach (var evidenceId in edge["evidenceIds"]!.AsArray())
                Assert.Contains(response["evidence"]!.AsArray(), evidence => evidence!["id"]!.GetValue<string>() == evidenceId!.GetValue<string>());
        }
    }

    [Fact]
    public void SourceTruncationReportsExactRangesWithoutAnUnusableCursor()
    {
        var code = "class Example {\n string Huge() => \"" + string.Concat(Enumerable.Repeat("😀", 2000)) + "\";\n}";
        File.WriteAllText(Path.Combine(root, "Example.cs"), code); indexer.Index(repository);
        var symbol = Symbol("Huge");
        var response = Query("get_source", new() { ["symbolId"] = symbol["symbolId"]!.DeepClone(), ["responseBudgetTokens"] = 1200 });
        Assert.Null(response["error"]); Assert.True(response["truncated"]!.GetValue<bool>()); Assert.Null(response["nextCursor"]);
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(response.ToJsonString()) <= 3600);
        var fragment = response["data"]!["fragments"]![0]!; var text = fragment["text"]!.GetValue<string>();
        Assert.DoesNotContain("�", text);
        var start = fragment["range"]!["start"]!; var end = fragment["range"]!["end"]!;
        var sourceText = Microsoft.CodeAnalysis.Text.SourceText.From(code);
        var startOffset = sourceText.Lines[start["line"]!.GetValue<int>()].Start + start["character"]!.GetValue<int>();
        var endOffset = sourceText.Lines[end["line"]!.GetValue<int>()].Start + end["character"]!.GetValue<int>();
        Assert.Equal(code[startOffset..endOffset], text);
        var byLines = Query("get_source", new() { ["symbolId"] = Symbol("Example")["symbolId"]!.DeepClone(), ["maxLines"] = 1 });
        Assert.True(byLines["truncated"]!.GetValue<bool>()); Assert.Null(byLines["nextCursor"]);
    }

    [Fact]
    public void BudgetReducedPagesResumeWithoutSkippingAndRetainReferencedEvidence()
    {
        File.WriteAllText(Path.Combine(root, "Example.cs"), string.Join("\n", Enumerable.Range(0, 20).Select(i => "class BudgetEntry" + i + " {}")));
        indexer.Index(repository);
        var input = new JsonObject { ["query"] = "Budget", ["mode"] = "lexical", ["limit"] = 50, ["responseBudgetTokens"] = 1200 };
        var seen = new HashSet<string>(); var pages = 0;
        do
        {
            var response = Query("search_code", input); Assert.Null(response["error"]);
            Assert.True(System.Text.Encoding.UTF8.GetByteCount(response.ToJsonString()) <= 3600);
            var matches = response["data"]!["matches"]!.AsArray(); Assert.NotEmpty(matches);
            foreach (var match in matches)
            {
                Assert.True(seen.Add(match!["symbol"]!["symbolId"]!.GetValue<string>()));
                foreach (var id in match["symbol"]!["declarations"]!.AsArray())
                    Assert.Contains(response["evidence"]!.AsArray(), evidence => evidence!["id"]!.GetValue<string>() == id!.GetValue<string>());
            }
            input["cursor"] = response["nextCursor"]?.DeepClone();
            Assert.True(++pages <= 20);
        } while (input["cursor"] is not null);
        Assert.Equal(20, seen.Count); Assert.True(pages > 1);
    }

    [Fact]
    public void PossibleDispatchIsOptInAndBaseCallsStayStaticallyBound()
    {
        File.WriteAllText(Path.Combine(root, "Example.cs"), "interface IWorker { int Work(); } class Base { public virtual int Work() => 1; } class Derived : Base, IWorker { public override int Work() => base.Work(); } class Caller { int ViaBase(Base value) => value.Work(); int ViaInterface(IWorker value) => value.Work(); }");
        indexer.Index(repository);
        foreach (var name in new[] { "ViaBase", "ViaInterface" })
        {
            var caller = Symbol(name); var id = caller["symbolId"]!.GetValue<string>();
            var definite = Query("get_callees", new() { ["symbolId"] = id });
            Assert.Single(definite["data"]!["items"]!.AsArray());
            var possible = Query("get_callees", new() { ["symbolId"] = id, ["includePossibleTargets"] = true });
            Assert.Null(possible["error"]);
            Assert.Equal(2, possible["data"]!["items"]!.AsArray().Count);
            var candidate = Assert.Single(possible["data"]!["items"]!.AsArray(), edge => edge!["kind"]!.GetValue<string>() == "may_call");
            Assert.Equal("possible", candidate!["resolution"]!.GetValue<string>());
            Assert.NotEmpty(candidate["evidenceIds"]!.AsArray());
        }
        var derived = Query("find_symbol", new() { ["name"] = "Work", ["qualifiedName"] = "Derived.Work()" })["data"]!["items"]![0]!;
        Assert.Single(Query("get_callees", new() { ["symbolId"] = derived["symbolId"]!.DeepClone(), ["includePossibleTargets"] = true })["data"]!["items"]!.AsArray());
        var overridden = Query("find_related", new() { ["symbolId"] = derived["symbolId"]!.DeepClone(), ["kinds"] = new JsonArray("overrides") });
        Assert.Single(overridden["data"]!["items"]!.AsArray());
        Assert.Equal("Base.Work()", overridden["data"]!["items"]![0]!["symbol"]!["qualifiedName"]!.GetValue<string>());
    }

    [Fact]
    public void TypeRelationshipsHaveEvidenceAndNeverLeakIntoCallQueries()
    {
        File.WriteAllText(Path.Combine(root, "Example.cs"), "interface IContract {} interface IDerived : IContract {} class Base {} class Derived : Base, IDerived {}");
        indexer.Index(repository);
        var derived = Symbol("Derived"); var id = derived["symbolId"]!.GetValue<string>();
        Assert.Empty(Query("get_callees", new() { ["symbolId"] = id })["data"]!["items"]!.AsArray());
        var related = Query("find_related", new() { ["symbolId"] = id, ["kinds"] = new JsonArray("implements") });
        Assert.Null(related["error"]);
        Assert.Single(related["data"]!["items"]!.AsArray());
        Assert.Contains("IDerived", related["data"]!["items"]![0]!["symbol"]!["qualifiedName"]!.GetValue<string>());
        var trace = Query("trace_flow", new() { ["symbolId"] = id, ["edgeKinds"] = new JsonArray("inherits", "implements") });
        Assert.Null(trace["error"]);
        Assert.Equal(3, trace["data"]!["edges"]!.AsArray().Count);
        Assert.All(trace["data"]!["edges"]!.AsArray(), edge => Assert.NotEmpty(edge!["evidenceIds"]!.AsArray()));
        var contract = Symbol("IContract");
        Assert.Empty(Query("get_callers", new() { ["symbolId"] = contract["symbolId"]!.DeepClone() })["data"]!["items"]!.AsArray());
        Assert.Empty(database.Check());
    }

    [Fact]
    public void LargeValidFiltersKeepCursorsWithinTheWireLimit()
    {
        var kinds = new JsonArray("method"); for (var index = 0; index < 49; index++) kinds.Add(new string('x', 60) + index);
        var input = new JsonObject { ["query"] = "Overload " + new string('q', 1900), ["mode"] = "lexical", ["limit"] = 1, ["filters"] = new JsonObject { ["kinds"] = kinds } };
        var first = Query("search_code", input); Assert.Null(first["error"]);
        Assert.InRange(first["nextCursor"]!.GetValue<string>().Length, 1, 4096);
        input["cursor"] = first["nextCursor"]!.DeepClone(); Assert.Null(Query("search_code", input)["error"]);
    }

    [Fact]
    public void ManualAliasesSurviveBodyRepublishAndRespectStructuralFilters()
    {
        var target = Symbol("Target"); var symbolId = target["symbolId"]!.GetValue<string>(); indexer.AddAlias(repository, symbolId, "unusual concept phrase");
        var response = Query("search_code", new() { ["query"] = "unusual concept phrase", ["mode"] = "lexical" });
        Assert.Single(response["data"]!["matches"]!.AsArray()); Assert.Contains(response["data"]!["matches"]![0]!["reasons"]!.AsArray(), reason => reason!.GetValue<string>() == "alias");
        File.AppendAllText(Path.Combine(root, "Example.cs"), " // changed body revision"); indexer.Index(repository);
        Assert.Single(Query("search_code", new() { ["query"] = "unusual concept phrase", ["mode"] = "lexical" })["data"]!["matches"]!.AsArray());
        Assert.Empty(Query("search_code", new() { ["query"] = "unusual concept phrase", ["mode"] = "lexical", ["filters"] = new JsonObject { ["kinds"] = new JsonArray("type") } })["data"]!["matches"]!.AsArray());
    }

    [Fact]
    public void ExactSearchOverloadsAndEvidenceHaveNormativeEnvelope()
    {
        var response = Query("search_code", new() { ["query"] = "Target", ["mode"] = "hybrid" });
        Assert.Null(response["error"]); Assert.Equal("1.2", response["schemaVersion"]!.GetValue<string>());
        Assert.NotEmpty(response["data"]!["matches"]!.AsArray()); Assert.Single(response["warnings"]!.AsArray());
        var overloads = Query("find_symbol", new() { ["name"] = "Overload" }); Assert.Equal(2, overloads["data"]!["items"]!.AsArray().Count);
        Assert.True(overloads["data"]!["ambiguous"]!.GetValue<bool>());
        var symbol = Symbol("Target"); var get = Query("get_symbol", new() { ["symbolId"] = symbol["symbolId"]!.DeepClone() });
        Assert.Equal(symbol["symbolId"]!.GetValue<string>(), get["data"]!["symbol"]!["symbolId"]!.GetValue<string>());
        Assert.NotEmpty(get["evidence"]!.AsArray());
    }

    [Fact]
    public void SourceIsHashCheckedAndChangesAreRejected()
    {
        var symbol = Symbol("Target"); var id = symbol["symbolId"]!.GetValue<string>();
        var response = Query("get_source", new() { ["symbolId"] = id }); Assert.Null(response["error"]);
        Assert.Contains("Target", response["data"]!["fragments"]![0]!["text"]!.GetValue<string>());
        var fragment = response["data"]!["fragments"]![0]!;
        var byRange = Query("get_source", new() { ["fileId"] = fragment["fileId"]!.DeepClone(), ["range"] = fragment["range"]!.DeepClone(), ["expectedContentHash"] = fragment["currentHash"]!.DeepClone() });
        Assert.Null(byRange["error"]);
        File.AppendAllText(Path.Combine(root, "Example.cs"), " // changed");
        Assert.Equal("SOURCE_CHANGED", Query("get_source", new() { ["symbolId"] = id })["error"]!["code"]!.GetValue<string>());
    }

    [Fact]
    public void ProjectDependenciesAreQueryableWithSourceEvidenceAndWithdrawAfterEdits()
    {
        File.WriteAllText(Path.Combine(root, "Library.cs"), "public class Library { public static int Value() => 1; }");
        File.WriteAllText(Path.Combine(root, "Example.cs"), "class Caller { int Run() => Library.Value(); }");
        var metadata = typeof(object).Assembly.Location;
        MetadataInput[] references = [new(metadata, SourceFiles.Hash(File.ReadAllBytes(metadata)))];
        File.WriteAllText(Path.Combine(root, "context.praxis.json"), JsonSerializer.Serialize(new PassiveManifest(1,
            [new("library", "Library", ["Library.cs"], Metadata: references), new("project", "Caller", ["Example.cs"], ["library"], references)])));
        indexer.Index(repository);
        var found = Query("find_symbol", new() { ["name"] = "[synthetic projectRoot]", ["qualifiedName"] = "Caller [synthetic projectRoot]" });
        Assert.Null(found["error"]);
        var module = Assert.Single(found["data"]!["items"]!.AsArray())!;
        var input = new JsonObject { ["symbolId"] = module["symbolId"]!.DeepClone(), ["edgeKinds"] = new JsonArray("depends_on") };
        var trace = Query("trace_flow", input); Assert.Null(trace["error"]);
        var edges = trace["data"]!["edges"]!.AsArray(); Assert.NotEmpty(edges);
        Assert.All(edges, edge =>
        {
            Assert.Equal("depends_on", edge!["kind"]!.GetValue<string>());
            Assert.Equal("resolved", edge["resolution"]!.GetValue<string>());
            var target = Assert.Single(trace["data"]!["nodes"]!.AsArray(), node => node!["symbolId"]!.GetValue<string>() == edge["targetSymbolId"]!.GetValue<string>());
            Assert.Equal("Library [synthetic projectRoot]", target!["qualifiedName"]!.GetValue<string>());
            Assert.NotEmpty(edge["evidenceIds"]!.AsArray());
            foreach (var id in edge["evidenceIds"]!.AsArray())
                Assert.Contains(trace["evidence"]!.AsArray(), evidence => evidence!["id"]!.GetValue<string>() == id!.GetValue<string>() && evidence["path"]!.GetValue<string>() == "Example.cs");
        });
        File.WriteAllText(Path.Combine(root, "Example.cs"), "class Caller { int Run() => 1; }"); indexer.Index(repository);
        Assert.Empty(Query("trace_flow", input)["data"]!["edges"]!.AsArray());
        Assert.Empty(database.Check());
    }

    [Fact]
    public void ImportGraphsPublishCompilerEvidenceAndDisappearWhenDirectivesAreRemoved()
    {
        const string code = "using System; using Alias = System.String; class Example {}";
        File.WriteAllText(Path.Combine(root, "Example.cs"), code); indexer.Index(repository);
        var module = Symbol("[synthetic projectRoot]");
        var input = new JsonObject { ["symbolId"] = module["symbolId"]!.DeepClone(), ["edgeKinds"] = new JsonArray("imports") };
        var trace = Query("trace_flow", input);
        Assert.Null(trace["error"]);
        var edges = trace["data"]!["edges"]!.AsArray(); Assert.Equal(2, edges.Count);
        Assert.All(edges, edge =>
        {
            Assert.Equal("imports", edge!["kind"]!.GetValue<string>());
            foreach (var evidenceId in edge["evidenceIds"]!.AsArray())
            {
                var evidence = Assert.Single(trace["evidence"]!.AsArray(), item => item!["id"]!.GetValue<string>() == evidenceId!.GetValue<string>());
                Assert.Equal("compiler", evidence!["provenance"]!.GetValue<string>());
                Assert.Equal("Example.cs", evidence["path"]!.GetValue<string>());
                var range = evidence["range"]!;
                var text = code[range["start"]!["character"]!.GetValue<int>()..range["end"]!["character"]!.GetValue<int>()];
                Assert.Contains(text, new[] { "System", "System.String" });
            }
        });
        Assert.Empty(Query("get_callees", new() { ["symbolId"] = module["symbolId"]!.DeepClone() })["data"]!["items"]!.AsArray());
        File.WriteAllText(Path.Combine(root, "Example.cs"), "class Example {}"); indexer.Index(repository);
        Assert.Empty(Query("trace_flow", input)["data"]!["edges"]!.AsArray());
        Assert.Empty(database.Check());
    }

    [Fact]
    public void EventAndExplicitThrowEdgesRemainSeparateFromCallQueries()
    {
        File.WriteAllText(Path.Combine(root, "Example.cs"), "delegate void Signal(); class Example { event Signal Changed; void Handler() {} void Wire() { Changed += Handler; } void Run() { Changed?.Invoke(); throw new System.InvalidOperationException(); } }"); indexer.Index(repository);
        var run = Symbol("Run"); var handler = Symbol("Handler");
        var trace = Query("trace_flow", new() { ["symbolId"] = run["symbolId"]!.DeepClone(), ["edgeKinds"] = new JsonArray("emits_event", "throws_explicitly") });
        Assert.Null(trace["error"]); var edges = trace["data"]!["edges"]!.AsArray();
        Assert.Single(edges, edge => edge!["kind"]!.GetValue<string>() == "emits_event");
        Assert.Single(edges, edge => edge!["kind"]!.GetValue<string>() == "throws_explicitly");
        var subscription = Query("trace_flow", new() { ["symbolId"] = handler["symbolId"]!.DeepClone(), ["edgeKinds"] = new JsonArray("handles_event") });
        Assert.Single(subscription["data"]!["edges"]!.AsArray());
        Assert.Empty(Query("get_callers", new() { ["symbolId"] = handler["symbolId"]!.DeepClone() })["data"]!["items"]!.AsArray());
    }

    [Fact]
    public void StaticGraphIncludesEndpointsAndCallsiteEvidence()
    {
        var caller = Symbol("Caller"); var target = Symbol("Target");
        var callees = Query("get_callees", new() { ["symbolId"] = caller["symbolId"]!.DeepClone() }); Assert.Single(callees["data"]!["items"]!.AsArray());
        Assert.Single(Query("get_callers", new() { ["symbolId"] = target["symbolId"]!.DeepClone() })["data"]!["items"]!.AsArray());
        var trace = Query("trace_flow", new() { ["symbolId"] = caller["symbolId"]!.DeepClone() }); Assert.Null(trace["error"]);
        var nodes = trace["data"]!["nodes"]!.AsArray().Select(n => n!["symbolId"]!.GetValue<string>()).ToHashSet();
        foreach (var edge in trace["data"]!["edges"]!.AsArray())
        {
            Assert.Contains(edge!["sourceSymbolId"]!.GetValue<string>(), nodes); Assert.Contains(edge["targetSymbolId"]!.GetValue<string>(), nodes);
            foreach (var evidence in edge["evidenceIds"]!.AsArray()) Assert.Contains(trace["evidence"]!.AsArray(), e => e!["id"]!.GetValue<string>() == evidence!.GetValue<string>());
        }
        Assert.Single(Query("find_related", new() { ["symbolId"] = caller["symbolId"]!.DeepClone(), ["kinds"] = new JsonArray("calls") })["data"]!["items"]!.AsArray());
    }

    [Fact]
    public void StatusExplanationSummaryAndVectorFallbackAreExplicit()
    {
        Assert.Null(Query("get_index_status")["error"]);
        Assert.Null(Query("explain_symbol", new() { ["symbolId"] = Symbol("Target")["symbolId"]!.DeepClone() })["error"]);
        using var connection = database.Open(readOnly: true); using var command = connection.CreateCommand(); command.CommandText = "SELECT project_id FROM projects";
        Assert.Null(Query("summarize_project", new() { ["projectId"] = (string)command.ExecuteScalar()! })["error"]);
        Assert.Equal("MODEL_UNAVAILABLE", Query("search_code", new() { ["query"] = "Target", ["mode"] = "vector" })["error"]!["code"]!.GetValue<string>());
    }

    [Fact]
    public void GrantsSchemasAndCursorEpochPreventCrossScopeOrMixedSnapshotReads()
    {
        var denial = queries.Execute("get_index_status", new() { ["repositoryId"] = repository }, new HashSet<string>());
        Assert.Equal("ACCESS_DENIED", denial["error"]!["code"]!.GetValue<string>()); Assert.Null(denial["indexGeneration"]);
        Assert.Equal("INVALID_ARGUMENT", Query("find_symbol", new() { ["name"] = "Target", ["extra"] = true })["error"]!["code"]!.GetValue<string>());
        var input = new JsonObject { ["name"] = "Overload", ["limit"] = 1 }; var first = Query("find_symbol", input);
        Assert.NotNull(first["nextCursor"]); input["cursor"] = first["nextCursor"]!.DeepClone(); Assert.Null(Query("find_symbol", input)["error"]);
        File.AppendAllText(Path.Combine(root, "Example.cs"), " // edit"); indexer.Index(repository);
        Assert.Equal("CURSOR_EXPIRED", Query("find_symbol", input)["error"]!["code"]!.GetValue<string>());
        Assert.Equal("INVALID_ARGUMENT", Query("get_source", new() { ["symbolId"] = "x", ["expectedContentHash"] = "sha256:" + new string('0', 64) })["error"]!["code"]!.GetValue<string>());
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}
