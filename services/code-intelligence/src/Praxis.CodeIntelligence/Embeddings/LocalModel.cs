using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using Praxis.CodeIntelligence.Indexing;

namespace Praxis.CodeIntelligence.Embeddings;

public sealed record EmbeddedChunk(float[] Vector, TokenizedChunk Span);

public sealed class LocalModel : IDisposable
{
    private readonly InferenceSession session;
    private readonly WordPieceTokenizer tokenizer;
    public string Fingerprint { get; }
    public string ManifestJson { get; }
    public const int Dimensions = 384;
    public const int RepresentationVersion = 2;
    public const string ModelId = "BAAI/bge-small-en-v1.5";
    public const string Revision = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";
    public const string ModelSha256 = "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35";
    public const string VocabSha256 = "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3";
    /// <summary>bge-small's retrieval instruction, prepended to queries only (documents take none).</summary>
    public const string QueryPrefix = "Represent this sentence for searching relevant passages: ";
    public LocalModel(string directory) : this(Verify(directory)) { }
    private LocalModel(VerifiedProfile profile)
    {
        ManifestJson = profile.ManifestJson; Fingerprint = profile.Fingerprint; tokenizer = profile.Tokenizer;
        using var options = new SessionOptions { InterOpNumThreads = 1, IntraOpNumThreads = Math.Clamp(Environment.ProcessorCount, 1, 4) };
        session = new InferenceSession(profile.Model, options);
    }
    private sealed record VerifiedProfile(string ManifestJson, string Fingerprint, WordPieceTokenizer Tokenizer, byte[] Model);
    /// <summary>Checks the manifest and asset hashes and returns the profile fingerprint without creating an inference session.</summary>
    public static string VerifyFingerprint(string directory) => Verify(directory).Fingerprint;
    private static VerifiedProfile Verify(string directory)
    {
        var manifest = ReadBounded(Path.Combine(directory, "manifest.json"), 64 * 1024);
        var node = JsonNode.Parse(manifest)!.AsObject();
        if (node["version"]?.GetValue<int>() != 1 || node["modelId"]?.GetValue<string>() != ModelId
            || node["revision"]?.GetValue<string>() != Revision
            || node["dimensions"]?.GetValue<int>() != Dimensions || node["maximumTokens"]?.GetValue<int>() != 256
            || node["license"]?.GetValue<string>() != "MIT" || node["pooling"]?.GetValue<string>() != "cls"
            || node["normalization"]?.GetValue<string>() != "l2" || node["metric"]?.GetValue<string>() != "cosine"
            || node["tokenizer"]?.GetValue<string>() != "bert-uncased-wordpiece-v3" || node["representationVersion"]?.GetValue<int>() != RepresentationVersion
            || node["queryPrefix"]?.GetValue<string>() != QueryPrefix || node["documentPrefix"]?.GetValue<string>() != "")
            throw new ArgumentException("Model manifest is not the supported baseline profile.");
        var model = ReadBounded(Path.Combine(directory, "model.onnx"), 160 * 1024 * 1024);
        var vocabulary = ReadBounded(Path.Combine(directory, "vocab.txt"), 4 * 1024 * 1024);
        var modelHash = Convert.ToHexStringLower(SHA256.HashData(model)); var vocabHash = Convert.ToHexStringLower(SHA256.HashData(vocabulary));
        if (modelHash != ModelSha256 || vocabHash != VocabSha256
            || node["modelSha256"]?.GetValue<string>() != modelHash || node["vocabSha256"]?.GetValue<string>() != vocabHash)
            throw new IOException("Model or tokenizer checksum mismatch.");
        var manifestJson = new JsonObject(node.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => KeyValuePair.Create(p.Key, p.Value?.DeepClone()))).ToJsonString();
        return new(manifestJson, SourceFiles.Hash(System.Text.Encoding.UTF8.GetBytes(manifestJson)),
            new(System.Text.Encoding.UTF8.GetString(vocabulary).Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(s => s.TrimEnd('\r'))), model);
    }
    public float[] EmbedQuery(string text, CancellationToken cancellationToken) => Embed(tokenizer.EncodeChunks(QueryPrefix + text, maximumChunks: 1)[0], cancellationToken);
    public float[] EmbedSection(string text, CancellationToken cancellationToken) => Embed(tokenizer.EncodeChunks(text, maximumChunks: 1)[0], cancellationToken);
    public IReadOnlyList<float[]> EmbedRepresentation(string text, CancellationToken cancellationToken) => EmbedDetailedRepresentation(text, cancellationToken).Select(chunk => chunk.Vector).ToArray();
    public IReadOnlyList<EmbeddedChunk> EmbedDetailedRepresentation(string text, CancellationToken cancellationToken) =>
        tokenizer.EncodeDetailed(text).Select(chunk => new EmbeddedChunk(Embed(chunk.Tokens, cancellationToken), chunk)).ToArray();
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
        // CLS pooling: the first position is always [CLS] (WordPieceTokenizer adds it to every chunk).
        var values = tensor.ToArray(); var pooled = new float[Dimensions]; Array.Copy(values, pooled, Dimensions);
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
        // Exactly sized: a growing MemoryStream doubles past the model size and then copies it again.
        using var file = File.OpenRead(path); if (file.Length > maximum) throw new IOException("Model asset exceeds its size limit.");
        var bytes = new byte[file.Length]; file.ReadExactly(bytes);
        if (file.ReadByte() != -1) throw new IOException("Model asset changed while it was read.");
        return bytes;
    }
    public void Dispose() => session.Dispose();
}
