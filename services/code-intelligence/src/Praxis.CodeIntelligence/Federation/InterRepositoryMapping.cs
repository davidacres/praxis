namespace Praxis.CodeIntelligence.Federation;

/// <summary>
/// Explicit cryptographically pinned cross-repository symbol mapping (§17, §35; CI-021 / TASK-461).
/// Cross-repository symbol navigation must be explicit, verifiable by target commit hash,
/// and prohibited from granting ambient access to ungranted repositories.
/// </summary>
public sealed record InterRepositoryMapping(
    string SourceRepositoryId,
    string TargetRepositoryId,
    string SourceSymbolId,
    string TargetSymbolId,
    string TargetCommitHash,
    DateTimeOffset VerifiedUtc
);

public sealed class InterRepositoryMappingRegistry
{
    private readonly Dictionary<string, InterRepositoryMapping> mappings = new(StringComparer.Ordinal);
    private readonly object gate = new();

    private static string Key(string sourceRepo, string sourceSymbol, string targetRepo) =>
        $"{sourceRepo}:{sourceSymbol}->{targetRepo}";

    public void Register(InterRepositoryMapping mapping)
    {
        ArgumentNullException.ThrowIfNull(mapping);
        if (string.IsNullOrWhiteSpace(mapping.SourceRepositoryId)) throw new ArgumentException("Source repository ID cannot be empty.");
        if (string.IsNullOrWhiteSpace(mapping.TargetRepositoryId)) throw new ArgumentException("Target repository ID cannot be empty.");
        if (string.IsNullOrWhiteSpace(mapping.SourceSymbolId)) throw new ArgumentException("Source symbol ID cannot be empty.");
        if (string.IsNullOrWhiteSpace(mapping.TargetSymbolId)) throw new ArgumentException("Target symbol ID cannot be empty.");
        if (string.IsNullOrWhiteSpace(mapping.TargetCommitHash)) throw new ArgumentException("Target commit hash cannot be empty.");

        lock (gate)
        {
            mappings[Key(mapping.SourceRepositoryId, mapping.SourceSymbolId, mapping.TargetRepositoryId)] = mapping;
        }
    }

    public bool TryResolve(string sourceRepo, string sourceSymbol, string targetRepo, string expectedCommitHash, out InterRepositoryMapping? mapping)
    {
        lock (gate)
        {
            if (mappings.TryGetValue(Key(sourceRepo, sourceSymbol, targetRepo), out var found))
            {
                // Enforce cryptographic pin on target commit hash to prevent stale/divergent resolution
                if (string.Equals(found.TargetCommitHash, expectedCommitHash, StringComparison.OrdinalIgnoreCase))
                {
                    mapping = found;
                    return true;
                }
            }
        }
        mapping = null;
        return false;
    }

    public int Count
    {
        get { lock (gate) return mappings.Count; }
    }
}
