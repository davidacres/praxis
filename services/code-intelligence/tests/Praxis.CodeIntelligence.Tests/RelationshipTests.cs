using System.Text;
using System.Text.Json;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class RelationshipTests
{
    private static RepositoryAnalysis Analyze(string code, bool semantic = true)
    {
        var source = new SourceInput("Example.cs", SourceFiles.Hash(Encoding.UTF8.GetBytes(code)), Encoding.UTF8.GetBytes(code), code);
        var assembly = typeof(object).Assembly.Location;
        var manifest = semantic ? new PassiveManifest(1, [new("project", "Project", ["Example.cs"], Metadata: [new(assembly, SourceFiles.Hash(File.ReadAllBytes(assembly)))])]) : null;
        return new RoslynAnalyzer().Analyze("repo", [source], manifest);
    }

    [Fact]
    public void CompilerClassifiesFieldPropertyAssignmentsAndArguments()
    {
        const string code = "class Example { int field; int Property { get; set; } static void Output(out int value) { value = 1; } static void Mutate(ref int value) {} int Run() { field = 1; field += 2; ++field; Output(out field); Mutate(ref field); Property = field; return Property; } }";
        var result = Analyze(code); Assert.All(result.Contexts, context => Assert.Equal("complete", context.Resolution));
        var field = Assert.Single(result.Symbols, symbol => symbol.Name == "field");
        var property = Assert.Single(result.Symbols, symbol => symbol.Name == "Property");
        var run = Assert.Single(result.Symbols, symbol => symbol.Name == "Run");
        var accesses = result.Relationships.Where(item => item.OwnerId == run.Id).ToArray();
        Assert.Equal(6, accesses.Count(item => item.TargetId == field.Id && item.Kind == "references"));
        Assert.Equal(4, accesses.Count(item => item.TargetId == field.Id && item.Kind == "reads"));
        Assert.Equal(5, accesses.Count(item => item.TargetId == field.Id && item.Kind == "writes"));
        Assert.Single(accesses, item => item.TargetId == property.Id && item.Kind == "reads");
        Assert.Single(accesses, item => item.TargetId == property.Id && item.Kind == "writes");
        Assert.All(accesses, item => { Assert.Equal("resolved", item.Resolution); Assert.True(item.End > item.Start); });
        Assert.Equal(result.Relationships.Count, result.Relationships.Select(item => item.Id).Distinct().Count());
    }

    [Fact]
    public void NameofIsReferenceOnlyAndSyntaxFallbackInventsNoSemanticEdges()
    {
        const string code = "class Example { int field; string Run() => nameof(field); }";
        var result = Analyze(code); var field = Assert.Single(result.Symbols, symbol => symbol.Name == "field");
        Assert.Single(result.Relationships, item => item.TargetId == field.Id && item.Kind == "references");
        Assert.DoesNotContain(result.Relationships, item => item.TargetId == field.Id && item.Kind is "reads" or "writes");
        Assert.Empty(Analyze(code, semantic: false).Relationships);
    }

    [Fact]
    public void DeclaredTypesHaveSeparateReferenceUseAndReturnEvidence()
    {
        const string code = "class Item {} class Example { Item field; Item Run(Item input) { Item local = input; return local; } }";
        var result = Analyze(code); var item = Assert.Single(result.Symbols, symbol => symbol.Name == "Item");
        var run = Assert.Single(result.Symbols, symbol => symbol.Name == "Run");
        Assert.Single(result.Relationships, edge => edge.OwnerId == run.Id && edge.TargetId == item.Id && edge.Kind == "returns_type");
        Assert.Equal(4, result.Relationships.Count(edge => edge.TargetId == item.Id && edge.Kind == "uses_type"));
        Assert.Equal(4, result.Relationships.Count(edge => edge.TargetId == item.Id && edge.Kind == "references"));
        Assert.DoesNotContain(result.Symbols, symbol => symbol.Name is "input" or "local");
    }

    [Fact]
    public void DeclaredMemberTypesBelongToEachFieldAndProperty()
    {
        var result = Analyze("class Item {} class Example { Item first, second; Item Property { get; set; } }");
        var item = Assert.Single(result.Symbols, symbol => symbol.Name == "Item");
        foreach (var name in new[] { "first", "second", "Property" })
        {
            var member = Assert.Single(result.Symbols, symbol => symbol.Name == name);
            Assert.Single(result.Relationships, edge => edge.OwnerId == member.Id && edge.TargetId == item.Id && edge.Kind == "uses_type");
        }
    }

    [Fact]
    public void NullCoalescingAssignmentReadsAndMayWriteTheProperty()
    {
        var result = Analyze("class Example { string Property { get; set; } void Run() { Property ??= \"fallback\"; } }");
        var property = Assert.Single(result.Symbols, symbol => symbol.Name == "Property");
        Assert.Single(result.Relationships, edge => edge.TargetId == property.Id && edge.Kind == "reads");
        Assert.Single(result.Relationships, edge => edge.TargetId == property.Id && edge.Kind == "writes");
    }

    [Fact]
    public void ReducedExtensionCallsAndReferencesUseTheSourceDefinition()
    {
        var result = Analyze("static class Extensions { public static int LengthValue(this string value) => value.Length; } class Example { int Run() => \"x\".LengthValue(); }");
        Assert.All(result.Contexts, context => Assert.Equal("complete", context.Resolution));
        var method = Assert.Single(result.Symbols, symbol => symbol.Name == "LengthValue");
        Assert.False(method.External);
        Assert.Single(result.Calls, edge => edge.TargetId == method.Id && edge.Kind == "calls");
        Assert.Single(result.Relationships, edge => edge.TargetId == method.Id && edge.Kind == "references");
    }

    [Fact]
    public void DirectEventSubscriptionsAndEmissionsRetainTheirDistinctMeaning()
    {
        var result = Analyze("delegate void Signal(); class Example { event Signal Changed; void Handler() {} void Wire() { Changed += Handler; Changed -= Handler; } void Run() { Changed(); Changed?.Invoke(); } }");
        Assert.All(result.Contexts, context => Assert.Equal("complete", context.Resolution));
        var signal = Assert.Single(result.Symbols, symbol => symbol.Name == "Changed");
        var handler = Assert.Single(result.Symbols, symbol => symbol.Name == "Handler");
        var run = Assert.Single(result.Symbols, symbol => symbol.Name == "Run");
        Assert.Single(result.Relationships, edge => edge.OwnerId == handler.Id && edge.TargetId == signal.Id && edge.Kind == "handles_event");
        Assert.Equal(2, result.Relationships.Count(edge => edge.OwnerId == run.Id && edge.TargetId == signal.Id && edge.Kind == "emits_event"));
        Assert.DoesNotContain(result.Symbols, symbol => symbol.External && symbol.QualifiedName.Contains("Signal.Invoke", StringComparison.Ordinal));
    }

    [Fact]
    public void UnknownEventHandlerFlowHasAnExplicitDiagnostic()
    {
        var result = Analyze("delegate void Signal(); class Example { event Signal Changed; void Wire(Signal handler) { Changed += handler; } }");
        Assert.DoesNotContain(result.Relationships, edge => edge.Kind == "handles_event");
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Code == "EVENT_HANDLER_UNRESOLVED");
    }

    [Fact]
    public void ExplicitThrowsIdentifyTypesAndRethrowDoesNotInventOne()
    {
        var result = Analyze("class Example { void Run() { try { throw new System.InvalidOperationException(); } catch { throw; } } int Value() => throw new System.ArgumentException(); }");
        var throws = result.Relationships.Where(edge => edge.Kind == "throws_explicitly").ToArray();
        Assert.Equal(2, throws.Length);
        Assert.All(throws, edge => Assert.True(result.Symbols.Single(symbol => symbol.Id == edge.TargetId).External));
        Assert.Equal(new[] { "ArgumentException", "InvalidOperationException" }, throws.Select(edge => result.Symbols.Single(symbol => symbol.Id == edge.TargetId).Name).Order());
    }

    [Fact]
    public void InterfaceMembersAndPropertyOverridesAreCompilerRelationships()
    {
        var result = Analyze("interface IWorker { int Work(); int Value { get; } } class Base { public virtual int Value => 1; } class Worker : Base, IWorker { public int Work() => 2; public override int Value => 3; }");
        Assert.All(result.Contexts, context => Assert.Equal("complete", context.Resolution));
        var implementation = Assert.Single(result.Symbols, symbol => symbol.QualifiedName == "Worker.Work()");
        var contract = Assert.Single(result.Symbols, symbol => symbol.QualifiedName == "IWorker.Work()");
        Assert.Single(result.Relationships, edge => edge.OwnerId == implementation.Id && edge.TargetId == contract.Id && edge.Kind == "implements");
        var property = Assert.Single(result.Symbols, symbol => symbol.QualifiedName == "Worker.Value");
        var baseProperty = Assert.Single(result.Symbols, symbol => symbol.QualifiedName == "Base.Value");
        var interfaceProperty = Assert.Single(result.Symbols, symbol => symbol.QualifiedName == "IWorker.Value");
        Assert.Single(result.Relationships, edge => edge.OwnerId == property.Id && edge.TargetId == baseProperty.Id && edge.Kind == "overrides");
        Assert.Single(result.Relationships, edge => edge.OwnerId == property.Id && edge.TargetId == interfaceProperty.Id && edge.Kind == "implements");
    }

    [Fact]
    public void RelationshipPublicationHasForeignKeysEvidenceAndNoOpStability()
    {
        var temporary = Path.Combine(Path.GetTempPath(), "praxis-relations-" + Guid.NewGuid().ToString("N"));
        var source = Path.Combine(temporary, "source"); Directory.CreateDirectory(source);
        try
        {
            File.WriteAllText(Path.Combine(source, "Example.cs"), "class Example { int field, other; int Run() { field = 1; return field; } }");
            var assembly = typeof(object).Assembly.Location;
            var manifest = new PassiveManifest(1, [new("project", "Project", ["Example.cs"], Metadata: [new(assembly, SourceFiles.Hash(File.ReadAllBytes(assembly)))])]);
            File.WriteAllText(Path.Combine(source, "context.praxis.json"), JsonSerializer.Serialize(manifest));
            var database = new IndexDatabase(Path.Combine(temporary, "data", "index.db")); database.Initialize();
            var indexer = new RepositoryIndexer(database); var id = indexer.Register(source, new("context.praxis.json"));
            indexer.Index(id); Assert.False(indexer.Index(id).Changed); Assert.Empty(database.Check());
            using var connection = database.Open(readOnly: true); using var command = connection.CreateCommand();
            command.CommandText = "SELECT count(*) FROM edges e JOIN occurrences o ON o.occurrence_id=e.occurrence_id WHERE e.kind IN('references','reads','writes','returns_type','uses_type') AND o.content_hash IS NOT NULL";
            Assert.True(Convert.ToInt64(command.ExecuteScalar()) >= 6);
        }
        finally { Directory.Delete(temporary, recursive: true); }
    }
}
