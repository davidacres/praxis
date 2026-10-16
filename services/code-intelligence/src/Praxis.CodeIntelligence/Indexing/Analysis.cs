using System.Text.Json;

namespace Praxis.CodeIntelligence.Indexing;

public sealed record Position(int Line, int Character);
public sealed record SourceRange(Position Start, Position End);
public sealed record IndexedLocation(string Id, string ContextId, string FilePath, string Hash, int Start, int End, SourceRange Range);
public sealed record IndexedSymbol(string Id, string Identity, string ContextId, string Kind, string Name, string QualifiedName,
    string Signature, string Revision, string Resolution, string? ContainerId, bool External, string Documentation,
    IReadOnlyList<IndexedLocation> Locations);
public sealed record IndexedCall(string Id, string ContextId, string FilePath, string Hash, string OwnerId, string? TargetId,
    int Start, int End, SourceRange Range, string Resolution, string Kind = "calls");
public sealed record IndexedDependency(string Id, string ContextId, string OwnerId, string TargetId,
    string InputRevision, string Resolution, string ReferenceIdentity, string? TargetContextId = null, string? RequiredContextHash = null);
public sealed record IndexedDiagnostic(string ContextId, string? FilePath, string Code, string Severity, string Message, SourceRange? Range);
public sealed record IndexedContext(string Key, string ProjectPath, string Id, string Hash, string Resolution, IReadOnlyList<SourceInput> Sources,
    string Language = "csharp", string AdapterVersion = RoslynAnalyzer.AdapterVersion);
public sealed record RepositoryAnalysis(IReadOnlyList<IndexedContext> Contexts, IReadOnlyList<IndexedSymbol> Symbols,
    IReadOnlyList<IndexedCall> Calls, IReadOnlyList<IndexedDiagnostic> Diagnostics)
{
    public IReadOnlyList<IndexedCall> Relationships { get; init; } = [];
    public IReadOnlyList<IndexedDependency> ConfiguredDependencies { get; init; } = [];
}

public static class Identity
{
    public static string Json(params object?[] parts) => JsonSerializer.Serialize(parts);
    public static string Id(string prefix, params object?[] parts) => prefix + SourceFiles.Hash(System.Text.Encoding.UTF8.GetBytes(Json(parts)))[7..];
}
