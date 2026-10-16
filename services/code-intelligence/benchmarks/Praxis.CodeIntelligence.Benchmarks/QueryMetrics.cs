using System.Collections.Concurrent;
using Praxis.CodeIntelligence.Queries;

// Warmups and diagnostic probes are excluded; one aggregate per timed batch.
internal sealed class QueryMetrics
{
    private ConcurrentBag<QueryMeasurement>? current;
    internal void Record(QueryMeasurement measurement) => Volatile.Read(ref current)?.Add(measurement);
    internal void Begin() => Volatile.Write(ref current, new());
    internal QueryPhaseSummary End()
    {
        var samples = Interlocked.Exchange(ref current, null)!.ToArray();
        PhaseDistribution Distribution(Func<QueryMeasurement, double> select)
        {
            var values = samples.Select(select).Order().ToArray();
            double? At(double fraction) => values.Length == 0 ? null : values[(int)Math.Ceiling(values.Length * fraction) - 1];
            return new(values.Length, At(.5), At(.95), At(.99), At(1));
        }
        return new(
            "Direct API phases; no owner admission queue or wire serialization. Model query includes model lookup and inference-lock wait. Retrieval includes SQL/vector/ranking/evidence. Response preparation includes budget serialization. Vector scan is a retrieval subcomponent.",
            samples.Length, samples.Count(sample => !sample.Succeeded),
            Distribution(sample => sample.ModelQueryIncludingLockMs), Distribution(sample => sample.RetrievalMs),
            Distribution(sample => sample.ExactVectorScanMs), Distribution(sample => sample.ResponsePreparationMs),
            Distribution(sample => sample.TotalMs));
    }
}
internal sealed record PhaseDistribution(int Count, double? P50Ms, double? P95Ms, double? P99Ms, double? MaximumMs);
internal sealed record QueryPhaseSummary(string Basis, int Count, int Errors, PhaseDistribution ModelQueryIncludingLock,
    PhaseDistribution Retrieval, PhaseDistribution ExactVectorScan, PhaseDistribution ResponsePreparation, PhaseDistribution Total);
