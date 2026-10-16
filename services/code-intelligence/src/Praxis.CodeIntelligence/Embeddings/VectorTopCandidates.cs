namespace Praxis.CodeIntelligence.Embeddings;

/// <summary>Exact streaming top-k of maximum chunk scores, independent of row order.</summary>
internal sealed class VectorTopCandidates(int capacity = 100)
{
    private static readonly IComparer<VectorCandidate> Order = Comparer<VectorCandidate>.Create((left, right) =>
    {
        var score = left.Score.CompareTo(right.Score);
        return score != 0 ? score : StringComparer.Ordinal.Compare(right.SymbolId, left.SymbolId);
    });
    private readonly int limit = capacity is >= 1 and <= 100 ? capacity : throw new ArgumentOutOfRangeException(nameof(capacity));
    private readonly SortedSet<VectorCandidate> ranked = new(Order);
    private readonly Dictionary<string, VectorCandidate> members = new(StringComparer.Ordinal);
    internal int Count => members.Count;

    // The threshold only increases. A discarded chunk cannot change a future
    // maximum unless a later chunk independently reaches the new threshold.
    // Equal scores still need the ID for the deterministic ordinal tie-break.
    internal bool CanImprove(double score) => ranked.Count < limit || score >= ranked.Min!.Score;

    internal void Add(string symbolId, double score)
    {
        if (!double.IsFinite(score)) throw new ArgumentException("Candidate score must be finite.", nameof(score));
        if (members.TryGetValue(symbolId, out var previous))
        {
            if (score <= previous.Score) return;
            ranked.Remove(previous);
        }
        else if (ranked.Count == limit)
        {
            var worst = ranked.Min!;
            if (score < worst.Score || score == worst.Score && StringComparer.Ordinal.Compare(symbolId, worst.SymbolId) >= 0) return;
            ranked.Remove(worst); members.Remove(worst.SymbolId);
        }
        var candidate = new VectorCandidate(symbolId, score);
        members[symbolId] = candidate; ranked.Add(candidate);
    }

    internal IReadOnlyList<VectorCandidate> Results() => ranked.Reverse().ToArray();
}
