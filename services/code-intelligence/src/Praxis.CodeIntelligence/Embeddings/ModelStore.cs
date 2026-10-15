using System.Buffers.Binary;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;

namespace Praxis.CodeIntelligence.Embeddings;

public sealed record ModelQuery(string Fingerprint, float[] Vector);
public sealed record VectorCandidate(string SymbolId, double Score);

public sealed class ModelStore(IndexDatabase database, string directory) : IDisposable
{
    private readonly object queryLock = new(); private LocalModel? cached; private string? cachedFingerprint;
    private string ProfileDirectory(string fingerprint)
    {
        if (fingerprint.Length != 71 || !fingerprint.StartsWith("sha256:", StringComparison.Ordinal) || fingerprint[7..].Any(c => !char.IsAsciiHexDigit(c)))
            throw new ArgumentException("Model fingerprint is invalid.");
        return Path.Combine(directory, fingerprint[7..]);
    }
    public string Install(string bundle)
    {
        using var candidate = new LocalModel(bundle); LocalModel.ValidateVector(candidate.EmbedQuery("Praxis code intelligence", CancellationToken.None));
        Directory.CreateDirectory(directory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var destination = ProfileDirectory(candidate.Fingerprint);
        if (!Directory.Exists(destination))
        {
            var stage = destination + "." + Guid.NewGuid().ToString("N") + ".tmp"; Directory.CreateDirectory(stage);
            try
            {
                foreach (var name in new[] { "manifest.json", "model.onnx", "vocab.txt" }) File.Copy(Path.Combine(bundle, name), Path.Combine(stage, name));
                using var verified = new LocalModel(stage);
                if (verified.Fingerprint != candidate.Fingerprint) throw new IOException("Model changed during installation.");
                Directory.Move(stage, destination);
            }
            finally { if (Directory.Exists(stage)) Directory.Delete(stage, recursive: true); }
        }
        else { using var verified = new LocalModel(destination); if (verified.Fingerprint != candidate.Fingerprint) throw new IOException("Installed model differs from requested profile."); }
        using var connection = database.Open();
        connection.Execute(null, "INSERT INTO model_profiles VALUES($0,$1,384,'cosine',$2) ON CONFLICT(fingerprint) DO NOTHING", candidate.Fingerprint, candidate.ManifestJson, LocalModel.RepresentationVersion);
        return candidate.Fingerprint;
    }

    public void Activate(string repositoryId, string fingerprint, CancellationToken cancellationToken, string? leaseToken = null)
    {
        using var model = new LocalModel(ProfileDirectory(fingerprint));
        if (model.Fingerprint != fingerprint) throw new IOException("Installed model fingerprint mismatch.");
        var repository = new RepositoryIndexer(database).Get(repositoryId);
        if (repository.State != "ready") throw new InvalidOperationException("INDEX_STALE: index must be ready before model activation.");
        var inputs = new List<(string Id, string Revision, SymbolRepresentation Representation)>();
        SourceInput? lastSource = null;
        var observedSources = new Dictionary<string, string>(StringComparer.Ordinal);
        using (var connection = database.Open(readOnly: true))
        using (var command = connection.Command(null, "SELECT s.symbol_id,s.revision,s.qualified_name,s.signature,d.documentation,d.description,f.relative_path,l.content_hash,l.start_offset,l.end_offset FROM symbols s JOIN search_documents d ON d.symbol_id=s.symbol_id LEFT JOIN locations l ON l.location_id=(SELECT first.location_id FROM locations first JOIN files first_file ON first_file.file_id=first.file_id WHERE first.symbol_id=s.symbol_id ORDER BY first_file.relative_path,first.start_offset LIMIT 1) LEFT JOIN files f ON f.file_id=l.file_id WHERE s.repository_id=$0 AND s.external=0 ORDER BY f.relative_path,s.symbol_id", repositoryId))
        using (var reader = command.ExecuteReader())
        {
            while (reader.Read())
            {
                SourceInput? source = null;
                if (!reader.IsDBNull(6))
                {
                    var path = reader.GetString(6);
                    if (lastSource?.Path != path) lastSource = SourceFiles.Read(repository.Root, path, cancellationToken);
                    source = lastSource;
                    if (source.Hash != reader.GetString(7)) throw new IOException("INDEX_STALE: source changed before embedding.");
                    observedSources[path] = source.Hash;
                }
                var representation = RepresentationBuilder.Build(reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.GetString(5),
                    source, source is null ? 0 : reader.GetInt32(8), source is null ? 0 : reader.GetInt32(9));
                inputs.Add((reader.GetString(0), reader.GetString(1), representation));
                if (inputs.Count > 50_000) throw new InvalidOperationException("VECTOR_CAPACITY_EXCEEDED");
            }
        }
        var embeddings = new List<(string Id, string Revision, SymbolRepresentation Representation, IReadOnlyList<EmbeddedChunk> Chunks)>();
        foreach (var input in inputs)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var chunks = model.EmbedDetailedRepresentation(input.Representation.Text, cancellationToken); foreach (var chunk in chunks) LocalModel.ValidateVector(chunk.Vector);
            embeddings.Add((input.Id, input.Revision, input.Representation, chunks));
        }
        foreach (var source in observedSources)
            if (SourceFiles.Read(repository.Root, source.Key, cancellationToken).Hash != source.Value)
                throw new IOException("INDEX_STALE: source changed during embedding.");
        using var writer = database.Open(); using var transaction = writer.BeginTransaction(deferred: false);
        if (Convert.ToInt64(writer.Scalar(transaction, "SELECT query_epoch FROM repositories WHERE repository_id=$0", repositoryId)) != repository.QueryEpoch)
            throw new InvalidOperationException("INDEX_STALE: embedding inputs changed during inference.");
        if (leaseToken is not null) Host.DurableScheduler.AssertLease(writer, transaction, leaseToken);
        writer.Execute(transaction, "UPDATE repository_models SET state='retiring' WHERE repository_id=$0 AND state='active' AND model_fingerprint!=$1", repositoryId, fingerprint);
        writer.Execute(transaction, "INSERT INTO repository_models VALUES($0,$1,'active',$2) ON CONFLICT(repository_id,model_fingerprint) DO UPDATE SET state='active',activated_utc=excluded.activated_utc", repositoryId, fingerprint, DateTimeOffset.UtcNow.ToString("O"));
        foreach (var item in embeddings)
        {
            writer.Execute(transaction, "UPDATE embedding_sets SET state='stale' WHERE symbol_id=$0 AND model_fingerprint=$1", item.Id, fingerprint);
            writer.Execute(transaction, "DELETE FROM embedding_sets WHERE symbol_id=$0 AND model_fingerprint=$1", item.Id, fingerprint);
            writer.Execute(transaction, "INSERT INTO representation_targets VALUES($0,$1,$2,$3,'eligible',NULL) ON CONFLICT(symbol_id,model_fingerprint) DO UPDATE SET input_revision=excluded.input_revision,representation_hash=excluded.representation_hash,eligibility='eligible',exclusion_reason=NULL", item.Id, fingerprint, item.Revision, item.Representation.Hash);
            var set = Identity.Id("pci:vector:", item.Id, fingerprint, item.Representation.Hash);
            writer.Execute(transaction, "INSERT INTO embedding_sets VALUES($0,$1,$2,$3,$4,$5,'pending',NULL)", set, item.Id, fingerprint, item.Revision, item.Representation.Hash, item.Chunks.Count);
            for (var index = 0; index < item.Chunks.Count; index++)
            {
                var values = new byte[LocalModel.Dimensions * 4]; for (var dimension = 0; dimension < LocalModel.Dimensions; dimension++) BinaryPrimitives.WriteSingleLittleEndian(values.AsSpan(dimension * 4, 4), item.Chunks[index].Vector[dimension]);
                var span = item.Chunks[index].Span;
                var sources = item.Representation.Sources.Where(source => source.RepresentationStart < span.End && source.RepresentationEnd > span.Start)
                    .Select(source => {
                        var start = Math.Max(source.RepresentationStart, span.Start); var end = Math.Min(source.RepresentationEnd, span.End);
                        return new { source.Path, source.ContentHash, Start = source.Start + start - source.RepresentationStart,
                            End = source.Start + end - source.RepresentationStart, RepresentationStart = start, RepresentationEnd = end };
                    });
                var spans = JsonSerializer.Serialize(new { CoordinateBasis = "utf16", span.Start, span.End, span.FirstToken, span.EndToken,
                    Truncated = span.Truncated || item.Representation.Truncated, RepresentationHash = item.Representation.Hash, Sources = sources });
                writer.Execute(transaction, "INSERT INTO vectors VALUES($0,$1,384,$2,$3)", set, index, values, spans);
            }
            writer.Execute(transaction, "UPDATE embedding_sets SET state='ready' WHERE set_id=$0", set);
        }
        writer.Execute(transaction, "UPDATE repositories SET query_epoch=query_epoch+1 WHERE repository_id=$0", repositoryId);
        if (leaseToken is not null) Host.DurableScheduler.AssertLease(writer, transaction, leaseToken);
        cancellationToken.ThrowIfCancellationRequested(); transaction.Commit();
    }

    public ModelQuery? QueryEmbedding(string repositoryId, string query, CancellationToken cancellationToken)
    {
        using var connection = database.Open(readOnly: true);
        var profile = connection.Scalar(null, "SELECT model_fingerprint FROM repository_models WHERE repository_id=$0 AND state='active'", repositoryId) as string;
        if (profile is null) return null;
        lock (queryLock)
        {
            if (cachedFingerprint != profile) { cached?.Dispose(); cached = new LocalModel(ProfileDirectory(profile)); cachedFingerprint = profile; }
            return new(profile, cached!.EmbedQuery(query, cancellationToken));
        }
    }

    public static IReadOnlyList<VectorCandidate> Candidates(SqliteConnection connection, SqliteTransaction transaction, string repositoryId, ModelQuery query, string? contextId, IReadOnlyList<string>? kinds, IReadOnlyList<string>? projectIds)
    {
        LocalModel.ValidateVector(query.Vector); var parameters = new List<object?> { repositoryId, query.Fingerprint, contextId };
        var filter = "";
        foreach (var (column, values) in new[] { ("s.kind", kinds), ("c.project_id", projectIds) })
        {
            if (values is null) continue;
            if (values.Count == 0) return [];
            var names = values.Select(value => { var parameter = "$" + parameters.Count; parameters.Add(value); return parameter; });
            filter += " AND " + column + " IN(" + string.Join(',', names) + ")";
        }
        using var command = connection.Command(transaction,
            "SELECT s.symbol_id,v.values_blob FROM vectors v JOIN embedding_sets e ON e.set_id=v.set_id JOIN representation_targets r ON r.symbol_id=e.symbol_id AND r.model_fingerprint=e.model_fingerprint JOIN symbols s ON s.symbol_id=e.symbol_id JOIN contexts c ON c.context_id=s.defining_context_id WHERE s.repository_id=$0 AND e.model_fingerprint=$1 AND ($2 IS NULL OR s.defining_context_id=$2) AND e.state='ready' AND e.input_revision=s.revision AND r.input_revision=s.revision AND r.representation_hash=e.representation_hash AND r.eligibility='eligible' AND v.dimensions=384 AND (SELECT count(*) FROM vectors complete WHERE complete.set_id=e.set_id)=e.expected_chunks" + filter, parameters.ToArray());
        using var reader = command.ExecuteReader(); var scores = new Dictionary<string, double>(StringComparer.Ordinal); var scanned = 0;
        while (reader.Read())
        {
            if (++scanned > 200_000) throw new InvalidOperationException("VECTOR_CAPACITY_EXCEEDED");
            var bytes = (byte[])reader.GetValue(1); if (bytes.Length != LocalModel.Dimensions * 4) continue;
            var vector = new float[LocalModel.Dimensions]; for (var dimension = 0; dimension < vector.Length; dimension++) vector[dimension] = BinaryPrimitives.ReadSingleLittleEndian(bytes.AsSpan(dimension * 4, 4));
            try { LocalModel.ValidateVector(vector); } catch (ArgumentException) { continue; }
            double score = 0; for (var dimension = 0; dimension < vector.Length; dimension++) score += vector[dimension] * query.Vector[dimension];
            var id = reader.GetString(0); scores[id] = Math.Max(scores.GetValueOrDefault(id, -1), score);
        }
        return scores.Select(p => new VectorCandidate(p.Key, p.Value)).OrderByDescending(p => p.Score).ThenBy(p => p.SymbolId, StringComparer.Ordinal).Take(100).ToArray();
    }
    public void Dispose() { lock (queryLock) { cached?.Dispose(); cached = null; } }
}
