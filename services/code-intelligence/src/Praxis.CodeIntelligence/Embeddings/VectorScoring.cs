using System.Buffers.Binary;
using System.Numerics;
using System.Runtime.InteropServices;

namespace Praxis.CodeIntelligence.Embeddings;

internal static class VectorScoring
{
    // Keep float-rounded products and double accumulation, as in the scalar
    // scorer. Widening before multiplication would change ranking precision.
    internal static bool TryScore(ReadOnlySpan<byte> bytes, ReadOnlySpan<float> query, out double score, bool accelerated = true)
    {
        score = 0;
        if (bytes.Length != LocalModel.Dimensions * sizeof(float) || query.Length != LocalModel.Dimensions) return false;
        double norm = 0;
        if (accelerated && BitConverter.IsLittleEndian && Vector.IsHardwareAccelerated)
        {
            var values = MemoryMarshal.Cast<byte, float>(bytes);
            var dotLow = Vector<double>.Zero; var dotHigh = Vector<double>.Zero;
            var normLow = Vector<double>.Zero; var normHigh = Vector<double>.Zero;
            var dimension = 0;
            for (; dimension <= values.Length - Vector<float>.Count; dimension += Vector<float>.Count)
            {
                var value = new Vector<float>(values.Slice(dimension));
                var product = value * new Vector<float>(query.Slice(dimension));
                Vector.Widen(product, out Vector<double> low, out Vector<double> high);
                dotLow += low; dotHigh += high;
                Vector.Widen(value, out low, out high);
                normLow += low * low; normHigh += high * high;
            }
            score = Vector.Sum(dotLow) + Vector.Sum(dotHigh);
            norm = Vector.Sum(normLow) + Vector.Sum(normHigh);
            for (; dimension < values.Length; dimension++)
            {
                var value = values[dimension];
                norm += (double)value * value; score += value * query[dimension];
            }
        }
        else
        {
            for (var dimension = 0; dimension < LocalModel.Dimensions; dimension++)
            {
                var value = BinaryPrimitives.ReadSingleLittleEndian(bytes.Slice(dimension * sizeof(float), sizeof(float)));
                norm += (double)value * value; score += value * query[dimension];
            }
        }
        // Any nonfinite component makes the squared norm nonfinite. Validate
        // after the reduction rather than branch once per dimension.
        return double.IsFinite(norm) && double.IsFinite(score) && Math.Abs(norm - 1) <= 0.001;
    }
}
