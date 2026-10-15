using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using Praxis.CodeIntelligence.Indexing;

namespace Praxis.CodeIntelligence.Embeddings;

public sealed class LocalModel : IDisposable
{
    private readonly InferenceSession session;
    private readonly WordPieceTokenizer tokenizer;
    public string Fingerprint { get; }
    public string ManifestJson { get; }
    public const int Dimensions = 384;
    public LocalModel(string directory)
    {
        var manifest = ReadBounded(Path.Combine(directory, "manifest.json"), 64 * 1024);
        var node = JsonNode.Parse(manifest)!.AsObject();
        if (node["version"]?.GetValue<int>() != 1 || node["modelId"]?.GetValue<string>() != "sentence-transformers/all-MiniLM-L6-v2"
            || node["revision"]?.GetValue<string>() != "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
            || node["dimensions"]?.GetValue<int>() != Dimensions || node["maximumTokens"]?.GetValue<int>() != 256
            || node["license"]?.GetValue<string>() != "Apache-2.0" || node["pooling"]?.GetValue<string>() != "attention-mask-mean"
            || node["normalization"]?.GetValue<string>() != "l2" || node["metric"]?.GetValue<string>() != "cosine"
            || node["tokenizer"]?.GetValue<string>() != "bert-uncased-wordpiece-v2" || node["representationVersion"]?.GetValue<int>() != 1
            || node["queryPrefix"]?.GetValue<string>() != "" || node["documentPrefix"]?.GetValue<string>() != "")
            throw new ArgumentException("Model manifest is not the supported baseline profile.");
        var model = ReadBounded(Path.Combine(directory, "model.onnx"), 128 * 1024 * 1024);
        var vocabulary = ReadBounded(Path.Combine(directory, "vocab.txt"), 4 * 1024 * 1024);
        var modelHash = Convert.ToHexStringLower(SHA256.HashData(model)); var vocabHash = Convert.ToHexStringLower(SHA256.HashData(vocabulary));
        if (modelHash != "6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452"
            || vocabHash != "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3"
            || node["modelSha256"]?.GetValue<string>() != modelHash || node["vocabSha256"]?.GetValue<string>() != vocabHash)
            throw new IOException("Model or tokenizer checksum mismatch.");
        ManifestJson = new JsonObject(node.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => KeyValuePair.Create(p.Key, p.Value?.DeepClone()))).ToJsonString();
        Fingerprint = SourceFiles.Hash(System.Text.Encoding.UTF8.GetBytes(ManifestJson));
        tokenizer = new(System.Text.Encoding.UTF8.GetString(vocabulary).Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(s => s.TrimEnd('\r')));
        using var options = new SessionOptions { InterOpNumThreads = 1, IntraOpNumThreads = Math.Clamp(Environment.ProcessorCount, 1, 4) };
        session = new InferenceSession(model, options);
    }
    public float[] EmbedQuery(string text, CancellationToken cancellationToken) => Embed(tokenizer.EncodeChunks(text, maximumChunks: 1)[0], cancellationToken);
    public IReadOnlyList<float[]> EmbedRepresentation(string text, CancellationToken cancellationToken) => tokenizer.EncodeChunks(text).Select(tokens => Embed(tokens, cancellationToken)).ToArray();
    private float[] Embed(long[] tokens, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var shape = new[] { 1, tokens.Length };
        var input = new List<NamedOnnxValue>
        {
            NamedOnnxValue.CreateFromTensor("input_ids", new DenseTensor<long>(tokens, shape)),
            NamedOnnxValue.CreateFromTensor("attention_mask", new DenseTensor<long>(Enumerable.Repeat(1L, tokens.Length).ToArray(), shape)),
            NamedOnnxValue.CreateFromTensor("token_type_ids", new DenseTensor<long>(new long[tokens.Length], shape))
        };
        using var run = new RunOptions(); using var registration = cancellationToken.Register(() => run.Terminate = true);
        using var output = session.Run(input, session.OutputMetadata.Keys.ToArray(), run);
        var tensor = output.First().AsTensor<float>();
        if (tensor.Dimensions.Length != 3 || tensor.Dimensions[0] != 1 || tensor.Dimensions[1] != tokens.Length || tensor.Dimensions[2] != Dimensions)
            throw new InvalidOperationException("Embedding model output dimensions differ from the profile.");
        var values = tensor.ToArray(); var pooled = new float[Dimensions];
        for (var token = 0; token < tokens.Length; token++) for (var dimension = 0; dimension < Dimensions; dimension++) pooled[dimension] += values[token * Dimensions + dimension] / tokens.Length;
        var norm = Math.Sqrt(pooled.Sum(value => (double)value * value));
        if (!double.IsFinite(norm) || norm <= 0) throw new InvalidOperationException("Embedding output is non-finite or zero.");
        for (var i = 0; i < pooled.Length; i++) pooled[i] = (float)(pooled[i] / norm);
        cancellationToken.ThrowIfCancellationRequested(); return pooled;
    }
    public static void ValidateVector(float[] vector)
    {
        if (vector.Length != Dimensions || vector.Any(v => !float.IsFinite(v)) || Math.Abs(vector.Sum(v => (double)v * v) - 1) > 0.001)
            throw new ArgumentException("Vector is not a normalized finite baseline embedding.");
    }
    private static byte[] ReadBounded(string path, int maximum)
    {
        using var file = File.OpenRead(path); if (file.Length > maximum) throw new IOException("Model asset exceeds its size limit.");
        using var buffer = new MemoryStream(); var chunk = new byte[64 * 1024]; int read;
        while ((read = file.Read(chunk)) > 0) { if (buffer.Length + read > maximum) throw new IOException("Model asset exceeds its size limit."); buffer.Write(chunk, 0, read); }
        return buffer.ToArray();
    }
    public void Dispose() => session.Dispose();
}
