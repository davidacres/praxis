using System.Buffers.Binary;
using Praxis.CodeIntelligence.Embeddings;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class VectorScoringTests
{
    [Fact]
    public void StreamingSelectionMatchesExhaustiveMaximaIncludingTiesAndLateChunks()
    {
        var random = new Random(41981);
        for (var sample = 0; sample < 10; sample++)
        {
            var chunks = Enumerable.Range(0, 1000).SelectMany(symbol => Enumerable.Range(0, 4)
                .Select(_ => new VectorCandidate($"symbol-{symbol:D4}", random.Next(-100, 101) / 100.0)))
                .OrderBy(_ => random.Next()).ToArray();
            var expected = chunks.GroupBy(chunk => chunk.SymbolId).Select(group => new VectorCandidate(group.Key, group.Max(chunk => chunk.Score)))
                .OrderByDescending(candidate => candidate.Score).ThenBy(candidate => candidate.SymbolId, StringComparer.Ordinal).Take(100).ToArray();
            var actual = new VectorTopCandidates();
            foreach (var chunk in chunks)
            {
                if (actual.CanImprove(chunk.Score)) actual.Add(chunk.SymbolId, chunk.Score);
                Assert.InRange(actual.Count, 1, 100);
            }
            Assert.Equal(expected, actual.Results());
        }
    }

    [Fact]
    public void AcceleratedAndPortableScoresMatchIndependentFloatProducts()
    {
        var random = new Random(41981);
        for (var sample = 0; sample < 1000; sample++)
        {
            float[] UnitVector()
            {
                var vector = Enumerable.Range(0, 384).Select(_ => (float)(random.NextDouble() * 2 - 1)).ToArray();
                var length = Math.Sqrt(vector.Sum(value => (double)value * value));
                return vector.Select(value => (float)(value / length)).ToArray();
            }
            var values = UnitVector(); var query = UnitVector();
            var bytes = new byte[384 * sizeof(float)];
            for (var i = 0; i < values.Length; i++) BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan(i * 4, 4), values[i]);
            var expected = values.Zip(query, (value, other) => (double)(value * other)).Sum();
            foreach (var accelerated in new[] { false, true })
            {
                Assert.True(VectorScoring.TryScore(bytes, query, out var score, accelerated));
                Assert.Equal(expected, score, 12);
            }
        }
    }

    [Fact]
    public void InvalidComponentsNormsAndLengthsNeverBecomeCandidates()
    {
        var query = new float[384]; query[0] = 1;
        foreach (var accelerated in new[] { false, true })
        {
            Assert.False(VectorScoring.TryScore(new byte[383 * 4], query, out _, accelerated));
            Assert.False(VectorScoring.TryScore(new byte[384 * 4], query.AsSpan(1), out _, accelerated));
            foreach (var index in new[] { 0, 1, 3, 7, 127, 383 })
            foreach (var bad in new[] { float.NaN, float.PositiveInfinity, float.NegativeInfinity, float.MaxValue, 2f, 0f })
            {
                var bytes = new byte[384 * 4];
                BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan(index * 4, 4), bad);
                Assert.False(VectorScoring.TryScore(bytes, query, out _, accelerated));
            }
        }
    }
}
