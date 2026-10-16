using Microsoft.Data.Sqlite;

namespace Praxis.CodeIntelligence.Embeddings;

public sealed record VectorSearchFilter(
    string? ContextId = null,
    IReadOnlyList<string>? Kinds = null,
    IReadOnlyList<string>? ProjectIds = null,
    IReadOnlyList<string>? Languages = null,
    int MaximumChunks = 200_000,
    int ValidationWindow = 1024
);

/// <summary>
/// Pluggable vector backend contract enabling evaluation of exact SIMD scanning,
/// partitioned search, and ANN index implementations (§23, §24, §35; CI-021 / TASK-461).
/// </summary>
public interface IVectorBackend
{
    string BackendName { get; }

    IReadOnlyList<VectorCandidate> FindCandidates(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string repositoryId,
        ModelQuery query,
        VectorSearchFilter filter,
        CancellationToken cancellationToken = default
    );
}
