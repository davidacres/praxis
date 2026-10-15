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
        input ??= new(); input["repositoryId"] = repository; input["responseBudgetTokens"] = 8000;
        var response = queries.Execute(tool, input, new HashSet<string> { repository });
        var directory = Environment.GetEnvironmentVariable("PRAXIS_CONTRACT_SAMPLES");
        if (directory is not null) { Directory.CreateDirectory(directory); File.WriteAllText(Path.Combine(directory, tool + "-" + Guid.NewGuid() + ".json"), response.ToJsonString()); }
        return response;
    }
    private JsonObject Symbol(string name) => Query("find_symbol", new() { ["name"] = name })["data"]!["items"]![0]!.AsObject();

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
        Assert.Single(Query("find_related", new() { ["symbolId"] = caller["symbolId"]!.DeepClone() })["data"]!["items"]!.AsArray());
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
