using System.Buffers.Binary;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;

namespace Praxis.CodeIntelligence.Embeddings;

internal sealed record ReusableChunk(byte[] Values, TokenizedChunk Span, string Metadata);
internal sealed record ReusableEmbedding(string SymbolId, string Fingerprint, string Revision, string Hash, int ExpectedChunks, List<ReusableChunk> Chunks);

/// <summary>Bounded transaction-local reuse; no orphaned cache survives exclusions or repository removal.</summary>
internal static class EmbeddingReuse
{
    public static Dictionary<(string Symbol, string Profile), ReusableEmbedding> Capture(SqliteConnection connection,
        SqliteTransaction? transaction, string repositoryId, CancellationToken cancellationToken, string? profile = null)
    {
        var result = new Dictionary<(string, string), ReusableEmbedding>(); long bytesRead = 0;
        using var command = connection.Command(transaction,
            "SELECT e.symbol_id,e.model_fingerprint,e.input_revision,e.representation_hash,v.chunk_index,v.values_blob,v.spans_json,e.expected_chunks " +
            "FROM embedding_sets e JOIN vectors v ON v.set_id=e.set_id JOIN symbols s ON s.symbol_id=e.symbol_id " +
            "JOIN representation_targets t ON t.symbol_id=e.symbol_id AND t.model_fingerprint=e.model_fingerprint " +
            "JOIN model_profiles m ON m.fingerprint=e.model_fingerprint JOIN repository_models r ON r.repository_id=s.repository_id AND r.model_fingerprint=e.model_fingerprint " +
            "WHERE s.repository_id=$0 AND ($1 IS NULL OR e.model_fingerprint=$1) AND (r.state='active' OR ($1 IS NOT NULL AND r.state='building')) " +
            "AND m.representation_version=2 AND json_extract(m.manifest_json,'$.tokenizer')='bert-uncased-wordpiece-v3' " +
            "AND e.state='ready' AND e.input_revision=s.revision AND t.input_revision=s.revision AND t.representation_hash=e.representation_hash AND t.eligibility='eligible' " +
            "AND (SELECT count(*) FROM vectors complete WHERE complete.set_id=e.set_id)=e.expected_chunks " +
            "ORDER BY e.symbol_id,e.model_fingerprint,v.chunk_index", repositoryId, profile);
        using var reader = command.ExecuteReader(); var invalid = new HashSet<(string, string)>();
        while (reader.Read())
        {
            cancellationToken.ThrowIfCancellationRequested();
            var key = (reader.GetString(0), reader.GetString(1)); if (invalid.Contains(key)) continue;
            try
            {
                var values = (byte[])reader.GetValue(5); var json = reader.GetString(6);
                bytesRead += values.Length + json.Length * 2L;
                if (bytesRead > 128L * 1024 * 1024) break;
                Validate(values);
                var span = JsonNode.Parse(json)!;
                // Older metadata without separate token/input truncation is re-inferred.
                var tokenSpan = new TokenizedChunk([], span["Start"]!.GetValue<int>(), span["End"]!.GetValue<int>(),
                    span["FirstToken"]!.GetValue<int>(), span["EndToken"]!.GetValue<int>(), span["TokenTruncated"]!.GetValue<bool>());
                if (span["CoordinateBasis"]?.GetValue<string>() != "utf16"
                    || tokenSpan.FirstToken != reader.GetInt32(4) * 254
                    || tokenSpan.Start < 0 || tokenSpan.End < tokenSpan.Start || tokenSpan.FirstToken < 0
                    || tokenSpan.EndToken < tokenSpan.FirstToken || tokenSpan.EndToken - tokenSpan.FirstToken > 254
                    || span["RepresentationHash"]!.GetValue<string>() != reader.GetString(3)) throw new ArgumentException("Invalid cached span.");
                if (!result.TryGetValue(key, out var set)) result[key] = set = new(key.Item1, key.Item2, reader.GetString(2), reader.GetString(3), reader.GetInt32(7), []);
                if (set.ExpectedChunks is < 1 or > 4 || reader.GetInt32(4) != set.Chunks.Count) throw new ArgumentException("Incomplete cached chunks.");
                set.Chunks.Add(new(values, tokenSpan, json));
            }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or NullReferenceException or FormatException or OverflowException or System.Text.Json.JsonException)
            { result.Remove(key); invalid.Add(key); }
        }
        foreach (var key in result.Where(pair => pair.Value.Chunks.Count != pair.Value.ExpectedChunks).Select(pair => pair.Key).ToArray()) result.Remove(key);
        return result;
    }
    public static float[] Decode(byte[] bytes)
    {
        if (bytes.Length != LocalModel.Dimensions * 4) throw new ArgumentException("Invalid vector bytes.");
        var vector = new float[LocalModel.Dimensions];
        for (var i = 0; i < vector.Length; i++) vector[i] = BinaryPrimitives.ReadSingleLittleEndian(bytes.AsSpan(i * 4, 4));
        LocalModel.ValidateVector(vector); return vector;
    }
    private static void Validate(byte[] values) => Decode(values);

    public static void Publish(SqliteConnection connection, SqliteTransaction transaction, RepositoryAnalysis analysis,
        IReadOnlyList<SourceInput> sources, IReadOnlyDictionary<(string Symbol, string Profile), ReusableEmbedding> captured,
        CancellationToken cancellationToken, SqlBatch batch)
    {
        if (captured.Count == 0) return;
        var byPath = sources.ToDictionary(source => source.Path, StringComparer.Ordinal);
        var bySymbol = captured.Values.ToLookup(set => set.SymbolId, StringComparer.Ordinal);
        foreach (var symbol in analysis.Symbols.Where(symbol => !symbol.External))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!bySymbol.Contains(symbol.Id)) continue;
            var location = symbol.Locations.OrderBy(location => location.FilePath, StringComparer.Ordinal).ThenBy(location => location.Start).FirstOrDefault();
            var source = location is null ? null : byPath[location.FilePath];
            var representation = RepresentationBuilder.Build(symbol.QualifiedName, symbol.Signature, symbol.Documentation,
                $"{symbol.Kind} {symbol.QualifiedName}. {symbol.Signature}", source, location?.Start ?? 0, location?.End ?? 0);
            foreach (var cached in bySymbol[symbol.Id])
            {
                if (cached.Hash != representation.Hash || cached.Chunks.Any(chunk => chunk.Span.End > representation.Text.Length)) continue;
                var setId = Identity.Id("pci:vector:", symbol.Id, cached.Fingerprint, representation.Hash);
                batch.Execute("INSERT INTO representation_targets VALUES($0,$1,$2,$3,'eligible',NULL)", symbol.Id, cached.Fingerprint, symbol.Revision, representation.Hash);
                batch.Execute("INSERT INTO embedding_sets VALUES($0,$1,$2,$3,$4,$5,'pending',NULL)", setId, symbol.Id, cached.Fingerprint, symbol.Revision, representation.Hash, cached.ExpectedChunks);
                for (var i = 0; i < cached.Chunks.Count; i++)
                    batch.Execute("INSERT INTO vectors VALUES($0,$1,384,$2,$3)", setId, i, cached.Chunks[i].Values, RepresentationBuilder.ChunkMetadata(representation, cached.Chunks[i].Span));
                batch.Execute("UPDATE embedding_sets SET state='ready' WHERE set_id=$0", setId);
            }
        }
    }
}
