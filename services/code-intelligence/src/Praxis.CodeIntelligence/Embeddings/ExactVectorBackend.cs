using Microsoft.Data.Sqlite;

namespace Praxis.CodeIntelligence.Embeddings;

/// <summary>
/// Reference exact vector search backend using SIMD hardware-accelerated scoring
/// and dense SQLite row-scanning with full validation.
/// </summary>
public sealed class ExactVectorBackend : IVectorBackend
{
    public string BackendName => "exact-simd";

    public IReadOnlyList<VectorCandidate> FindCandidates(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string repositoryId,
        ModelQuery query,
        VectorSearchFilter filter,
        CancellationToken cancellationToken = default)
    {
        return ModelStore.CandidatesCore(
            connection,
            transaction,
            repositoryId,
            query,
            filter.ContextId,
            filter.Kinds,
            filter.ProjectIds,
            cancellationToken,
            filter.MaximumChunks,
            filter.ValidationWindow,
            filter.Languages
        );
    }
}
