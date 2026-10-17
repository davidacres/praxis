using System.Buffers.Binary;
using System.Text;
using Microsoft.Data.Sqlite;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;

namespace Praxis.CodeIntelligence.Embeddings;

public sealed record ModelQuery(string Fingerprint, float[] Vector);
public sealed record VectorCandidate(string SymbolId, double Score);

public sealed class ModelStore(IndexDatabase database, string directory) : IDisposable
{
    public const int VectorScorerVersion = 4;
    public const int VectorQueryPlanVersion = 6;
    // Queried on the database volume, where both profiles and the SQLite WAL
    // may coexist during activation. Injectable only for deterministic fault tests.
    internal Func<string, long> AvailableDiskBytes { get; set; } = path => new DriveInfo(path).AvailableFreeSpace;
    private const long MinimumDiskReserve = 1024L * 1024 * 1024;
    private readonly object queryLock = new(); private LocalModel? cached; private string? cachedFingerprint;
    // One inference session per profile, shared by query embedding and activation; a replaced
    // session is disposed once no activation still holds it.
    private int activeUsers; private readonly List<LocalModel> retired = [];
    /// <summary>Inference sessions this store has created; observable so tests can hold the one-session rule.</summary>
    internal int SessionsCreated { get; private set; }
    private LocalModel Shared(string fingerprint)
    {
        if (cachedFingerprint != fingerprint)
        {
            if (cached is not null) { if (activeUsers == 0) cached.Dispose(); else retired.Add(cached); }
            cached = null; cachedFingerprint = null;
            cached = new LocalModel(ProfileDirectory(fingerprint)); cachedFingerprint = fingerprint; SessionsCreated++;
        }
        return cached!;
    }
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
                if (LocalModel.VerifyFingerprint(stage) != candidate.Fingerprint) throw new IOException("Model changed during installation.");
                Directory.Move(stage, destination);
            }
            finally { if (Directory.Exists(stage)) Directory.Delete(stage, recursive: true); }
        }
        else { if (LocalModel.VerifyFingerprint(destination) != candidate.Fingerprint) throw new IOException("Installed model differs from requested profile."); }
        using var connection = database.Open();
        connection.Execute(null, "INSERT INTO model_profiles VALUES($0,$1,384,'cosine',$2) ON CONFLICT(fingerprint) DO NOTHING", candidate.Fingerprint, candidate.ManifestJson, LocalModel.RepresentationVersion);
        return candidate.Fingerprint;
    }

    public void Activate(string repositoryId, string fingerprint, CancellationToken cancellationToken, string? leaseToken = null)
    {
        try { ActivateCore(repositoryId, fingerprint, cancellationToken, leaseToken); }
        finally { MemoryPressure.RelieveAfterWork(); }
    }

    private void ActivateCore(string repositoryId, string fingerprint, CancellationToken cancellationToken, string? leaseToken)
    {
        LocalModel model;
        lock (queryLock) { model = Shared(fingerprint); activeUsers++; }
        try { ActivateWith(model, repositoryId, fingerprint, cancellationToken, leaseToken); }
        finally { lock (queryLock) { if (--activeUsers == 0) { foreach (var old in retired) old.Dispose(); retired.Clear(); } } }
    }

    private void ActivateWith(LocalModel model, string repositoryId, string fingerprint, CancellationToken cancellationToken, string? leaseToken)
    {
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
        // Four chunks per symbol, float32 payload plus bounded span/index
        // overhead. Keep the larger of 1 GiB or twice the projected profile.
        // This preflight is advisory; publication remains transactional if disk
        // space disappears after the check.
        var projectedProfileBytes = checked(inputs.Count * 4L * (LocalModel.Dimensions * sizeof(float) + 4096));
        var requiredFreeBytes = Math.Max(MinimumDiskReserve, checked(2 * projectedProfileBytes));
        if (AvailableDiskBytes(Path.GetDirectoryName(Path.GetFullPath(database.Path))!) < requiredFreeBytes)
            throw new IOException("INSUFFICIENT_DISK_SPACE: model activation requires disk headroom for the new profile and recovery.");
        Dictionary<(string Symbol, string Profile), ReusableEmbedding> reusable;
        using (var read = database.Open(readOnly: true)) reusable = EmbeddingReuse.Capture(read, null, repositoryId, cancellationToken, fingerprint);
        var embeddings = new List<(string Id, string Revision, SymbolRepresentation Representation, IReadOnlyList<EmbeddedChunk> Chunks)>();
        foreach (var input in inputs)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var current = reusable.TryGetValue((input.Id, fingerprint), out var cached) && cached.Hash == input.Representation.Hash
                && cached.Revision == input.Revision && cached.Chunks.All(chunk => chunk.Span.End <= input.Representation.Text.Length);
            // Complete validated current sets require neither inference nor derivative rewrites.
            // Compare exact regenerated source metadata so corrupt/stale spans are still repaired.
            if (current && cached!.Chunks.All(chunk => chunk.Metadata == RepresentationBuilder.ChunkMetadata(input.Representation, chunk.Span))) continue;
            var chunks = current
                ? cached!.Chunks.Select(chunk => new EmbeddedChunk(EmbeddingReuse.Decode(chunk.Values), chunk.Span)).ToArray()
                : model.EmbedDetailedRepresentation(input.Representation.Text, cancellationToken);
            foreach (var chunk in chunks) LocalModel.ValidateVector(chunk.Vector);
            embeddings.Add((input.Id, input.Revision, input.Representation, chunks));
        }
        foreach (var source in observedSources)
            if (SourceFiles.Read(repository.Root, source.Key, cancellationToken).Hash != source.Value)
                throw new IOException("INDEX_STALE: source changed during embedding.");
        using var writer = database.Open(); using var transaction = writer.BeginTransaction(deferred: false);
        using var batch = new SqlBatch(writer, transaction);
        if (Convert.ToInt64(writer.Scalar(transaction, "SELECT query_epoch FROM repositories WHERE repository_id=$0", repositoryId)) != repository.QueryEpoch)
            throw new InvalidOperationException("INDEX_STALE: embedding inputs changed during inference.");
        if (leaseToken is not null) Host.DurableScheduler.AssertLease(writer, transaction, leaseToken);
        batch.Execute("UPDATE repository_models SET state='retiring' WHERE repository_id=$0 AND state='active' AND model_fingerprint!=$1", repositoryId, fingerprint);
        batch.Execute("INSERT INTO repository_models VALUES($0,$1,'active',$2) ON CONFLICT(repository_id,model_fingerprint) DO UPDATE SET state='active',activated_utc=excluded.activated_utc", repositoryId, fingerprint, DateTimeOffset.UtcNow.ToString("O"));
        foreach (var item in embeddings)
        {
            batch.Execute("UPDATE embedding_sets SET state='stale' WHERE symbol_id=$0 AND model_fingerprint=$1", item.Id, fingerprint);
            batch.Execute("DELETE FROM embedding_sets WHERE symbol_id=$0 AND model_fingerprint=$1", item.Id, fingerprint);
            batch.Execute("INSERT INTO representation_targets VALUES($0,$1,$2,$3,'eligible',NULL) ON CONFLICT(symbol_id,model_fingerprint) DO UPDATE SET input_revision=excluded.input_revision,representation_hash=excluded.representation_hash,eligibility='eligible',exclusion_reason=NULL", item.Id, fingerprint, item.Revision, item.Representation.Hash);
            var set = Identity.Id("pci:vector:", item.Id, fingerprint, item.Representation.Hash);
            batch.Execute("INSERT INTO embedding_sets VALUES($0,$1,$2,$3,$4,$5,'pending',NULL)", set, item.Id, fingerprint, item.Revision, item.Representation.Hash, item.Chunks.Count);
            for (var index = 0; index < item.Chunks.Count; index++)
            {
                var values = new byte[LocalModel.Dimensions * 4]; for (var dimension = 0; dimension < LocalModel.Dimensions; dimension++) BinaryPrimitives.WriteSingleLittleEndian(values.AsSpan(dimension * 4, 4), item.Chunks[index].Vector[dimension]);
                var span = item.Chunks[index].Span;
                var spans = RepresentationBuilder.ChunkMetadata(item.Representation, span);
                batch.Execute("INSERT INTO vectors VALUES($0,$1,384,$2,$3)", set, index, values, spans);
            }
            batch.Execute("UPDATE embedding_sets SET state='ready' WHERE set_id=$0", set);
        }
        batch.Execute("UPDATE repositories SET query_epoch=query_epoch+1 WHERE repository_id=$0", repositoryId);
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
            return new(profile, Shared(profile).EmbedQuery(query, cancellationToken));
        }
    }

    internal const int DefaultValidationWindow = 1024;

    /// <summary>
    /// Exact top-100 of complete, current, eligible vectors. Validity (symbol
    /// revision, representation target, completeness, filters) is checked only
    /// for candidates in rank order after a score pass over the dense
    /// trigger-maintained vector_scan copy; each accepted set is rescored from
    /// vectors, and any disagreement hands the query to the exhaustive scan.
    /// If fewer than 100 candidates validate and the ranked window was
    /// saturated, or the chunk capacity is exceeded, the full validated scan
    /// decides instead, so the result never depends on the window size.
    /// </summary>
    public static readonly IVectorBackend DefaultBackend = new ExactVectorBackend();
    public IVectorBackend VectorBackend { get; set; } = DefaultBackend;

    public static IReadOnlyList<VectorCandidate> Candidates(SqliteConnection connection, SqliteTransaction transaction, string repositoryId, ModelQuery query, string? contextId, IReadOnlyList<string>? kinds, IReadOnlyList<string>? projectIds, CancellationToken cancellationToken = default, int maximumChunks = 200_000, int validationWindow = DefaultValidationWindow, IReadOnlyList<string>? languages = null) =>
        CandidatesCore(connection, transaction, repositoryId, query, contextId, kinds, projectIds, cancellationToken, maximumChunks, validationWindow, languages);

    internal static IReadOnlyList<VectorCandidate> CandidatesCore(SqliteConnection connection, SqliteTransaction transaction, string repositoryId, ModelQuery query, string? contextId, IReadOnlyList<string>? kinds, IReadOnlyList<string>? projectIds, CancellationToken cancellationToken = default, int maximumChunks = 200_000, int validationWindow = DefaultValidationWindow, IReadOnlyList<string>? languages = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        LocalModel.ValidateVector(query.Vector);
        var window = new VectorTopCandidates(Math.Clamp(validationWindow, 100, VectorTopCandidates.MaximumCapacity));
        var scanned = 0; var bytes = new byte[LocalModel.Dimensions * 4];
        // The score pass has no repository predicate (that needs the symbols join
        // this path avoids), so it is only valid when every vector is this repository's.
        if (Convert.ToInt64(connection.Scalar(transaction, "SELECT count(*) FROM repositories")) != 1)
            return ExhaustiveCandidates(connection, transaction, repositoryId, query, contextId, kinds, projectIds, cancellationToken, maximumChunks, languages);
        // Stepped through SQLite directly and scored from SQLite's own row buffer:
        // the ADO.NET reader's per-row overhead and blob copy cost more than the
        // scoring itself. The statement runs inside the caller's read transaction.
        var overflow = false;
        {
            if (connection.Handle is not { } handle) throw new InvalidOperationException("Connection is not open.");
            // The copy's context and kind apply the same filters as validation, so
            // the ranked window holds only candidates that can pass; validation
            // below still checks every candidate against the source tables.
            var scanValues = new List<string?> { query.Fingerprint, contextId };
            var scanSql = new StringBuilder("SELECT symbol_id,values_blob FROM vector_scan WHERE model_fingerprint=?1 AND ready=1 AND dimensions=384 AND length(values_blob)=1536 AND (?2 IS NULL OR context_id=?2)");
            string Parameters(IReadOnlyList<string> values) => string.Join(',', values.Select(value => { scanValues.Add(value); return "?" + scanValues.Count; }));
            if (kinds is { Count: > 0 }) scanSql.Append(" AND kind IN(").Append(Parameters(kinds)).Append(')');
            if (projectIds is { Count: > 0 }) scanSql.Append(" AND context_id IN(SELECT context_id FROM contexts WHERE project_id IN(").Append(Parameters(projectIds)).Append("))");
            if (languages is { Count: > 0 })
            {
                var langParams = Parameters(languages);
                scanSql.Append(" AND (symbol_id IN(SELECT l.symbol_id FROM locations l JOIN files f ON f.file_id=l.file_id WHERE f.language IN(").Append(langParams).Append("))")
                    .Append(" OR (NOT EXISTS(SELECT 1 FROM locations l WHERE l.symbol_id=vector_scan.symbol_id) AND context_id IN(SELECT c.context_id FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.language IN(").Append(langParams).Append("))))");
            }
            ThrowOnError(handle, SQLitePCL.raw.sqlite3_prepare_v2(handle, scanSql.ToString(), out var scan));
            using (scan)
            {
                for (var index = 0; index < scanValues.Count; index++)
                    ThrowOnError(handle, scanValues[index] is string value ? SQLitePCL.raw.sqlite3_bind_text(scan, index + 1, value) : SQLitePCL.raw.sqlite3_bind_null(scan, index + 1));
                int step;
                while ((step = SQLitePCL.raw.sqlite3_step(scan)) == SQLitePCL.raw.SQLITE_ROW)
                {
                    if (++scanned > maximumChunks) { overflow = true; break; }
                    if ((scanned & 127) == 0) cancellationToken.ThrowIfCancellationRequested();
                    var values = SQLitePCL.raw.sqlite3_column_blob(scan, 1);
                    if (values.Length != bytes.Length || !VectorScoring.TryScore(values, query.Vector, out var score)) continue;
                    if (window.CanImprove(score)) window.Add(SQLitePCL.raw.sqlite3_column_text(scan, 0).utf8_to_string(), score);
                }
                if (!overflow && step != SQLitePCL.raw.SQLITE_DONE) ThrowOnError(handle, step);
            }
        }
        if (overflow) return ExhaustiveCandidates(connection, transaction, repositoryId, query, contextId, kinds, projectIds, cancellationToken, maximumChunks, languages);
        cancellationToken.ThrowIfCancellationRequested();
        var ranked = window.Results();
        // Fewer scored chunks than the window cannot have evicted anything,
        // so exhausting the ranking enumerates every possible candidate.
        var windowSaturated = window.Count >= Math.Clamp(validationWindow, 100, VectorTopCandidates.MaximumCapacity);
        var parameters = new List<object?> { repositoryId, query.Fingerprint, contextId, null };
        var filter = "";
        foreach (var (column, values) in new[] { ("s.kind", kinds), ("c.project_id", projectIds) })
        {
            if (values is null || values.Count == 0) continue;
            var names = values.Select(value => { var parameter = "$" + parameters.Count; parameters.Add(value); return parameter; });
            filter += " AND " + column + " IN(" + string.Join(',', names) + ")";
        }
        if (languages is { Count: > 0 })
        {
            var names = string.Join(',', languages.Select(value => { var parameter = "$" + parameters.Count; parameters.Add(value); return parameter; }));
            filter += $" AND (EXISTS(SELECT 1 FROM locations l JOIN files f ON f.file_id=l.file_id WHERE l.symbol_id=s.symbol_id AND f.language IN({names})) OR (NOT EXISTS(SELECT 1 FROM locations l WHERE l.symbol_id=s.symbol_id) AND s.defining_context_id IN(SELECT ctx.context_id FROM contexts ctx JOIN projects p ON p.project_id=ctx.project_id WHERE p.language IN({names}))))";
        }
        var contextJoin = projectIds is { Count: > 0 } ? " JOIN contexts c ON c.context_id=s.defining_context_id" : "";
        using var validate = connection.Command(transaction,
            "SELECT e.set_id FROM embedding_sets e JOIN representation_targets r ON r.symbol_id=e.symbol_id AND r.model_fingerprint=e.model_fingerprint JOIN symbols s ON s.symbol_id=e.symbol_id" + contextJoin + " WHERE e.symbol_id=$3 AND s.repository_id=$0 AND e.model_fingerprint=$1 AND ($2 IS NULL OR s.defining_context_id=$2) AND e.state='ready' AND e.input_revision=s.revision AND r.input_revision=s.revision AND r.representation_hash=e.representation_hash AND r.eligibility='eligible' AND (SELECT count(*) FROM vectors complete WHERE complete.set_id=e.set_id)=e.expected_chunks" + filter, parameters.ToArray());
        validate.Prepare();
        using var source = connection.Command(transaction, "SELECT values_blob FROM vectors WHERE set_id=$0 AND dimensions=384 AND length(values_blob)=1536", (object?)null);
        source.Prepare();
        var current = new List<VectorCandidate>(100);
        foreach (var candidate in ranked)
        {
            cancellationToken.ThrowIfCancellationRequested();
            validate.Parameters["$3"].Value = candidate.SymbolId;
            if (validate.ExecuteScalar() is not string set) continue;
            // Same bytes and scorer give the identical double; anything else
            // means vector_scan drifted from vectors, so trust neither.
            source.Parameters["$0"].Value = set; double? best = null;
            using (var reader = source.ExecuteReader())
                while (reader.Read())
                    if (reader.GetBytes(0, 0, bytes, 0, bytes.Length) == bytes.Length && VectorScoring.TryScore(bytes, query.Vector, out var score) && (best is null || score > best))
                        best = score;
            if (best != candidate.Score)
                return ExhaustiveCandidates(connection, transaction, repositoryId, query, contextId, kinds, projectIds, cancellationToken, maximumChunks, languages);
            current.Add(candidate);
            if (current.Count == 100) return current;
        }
        return windowSaturated
            ? ExhaustiveCandidates(connection, transaction, repositoryId, query, contextId, kinds, projectIds, cancellationToken, maximumChunks, languages)
            : current;
    }

    private static void ThrowOnError(SQLitePCL.sqlite3 handle, int code)
    {
        if (code is not (SQLitePCL.raw.SQLITE_OK or SQLitePCL.raw.SQLITE_ROW or SQLitePCL.raw.SQLITE_DONE))
            throw new SqliteException(SQLitePCL.raw.sqlite3_errmsg(handle).utf8_to_string(), code);
    }

    internal static IReadOnlyList<VectorCandidate> ExhaustiveCandidates(SqliteConnection connection, SqliteTransaction transaction, string repositoryId, ModelQuery query, string? contextId, IReadOnlyList<string>? kinds, IReadOnlyList<string>? projectIds, CancellationToken cancellationToken = default, int maximumChunks = 200_000, IReadOnlyList<string>? languages = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        LocalModel.ValidateVector(query.Vector); var parameters = new List<object?> { repositoryId, query.Fingerprint, contextId };
        var filter = "";
        foreach (var (column, values) in new[] { ("s.kind", kinds), ("c.project_id", projectIds) })
        {
            if (values is null) continue;
            if (values.Count == 0) continue;
            var names = values.Select(value => { var parameter = "$" + parameters.Count; parameters.Add(value); return parameter; });
            filter += " AND " + column + " IN(" + string.Join(',', names) + ")";
        }
        if (languages is { Count: > 0 })
        {
            var names = string.Join(',', languages.Select(value => { var parameter = "$" + parameters.Count; parameters.Add(value); return parameter; }));
            filter += $" AND (EXISTS(SELECT 1 FROM locations l JOIN files f ON f.file_id=l.file_id WHERE l.symbol_id=s.symbol_id AND f.language IN({names})) OR (NOT EXISTS(SELECT 1 FROM locations l WHERE l.symbol_id=s.symbol_id) AND s.defining_context_id IN(SELECT ctx.context_id FROM contexts ctx JOIN projects p ON p.project_id=ctx.project_id WHERE p.language IN({names}))))";
        }
        // Context identity is already constrained by the symbols FK. Only
        // project filtering needs the context row during the exhaustive scan.
        var contextJoin = projectIds is { Count: > 0 } ? " JOIN contexts c ON c.context_id=s.defining_context_id" : "";
        using var command = connection.Command(transaction,
            "SELECT s.symbol_id,v.values_blob FROM vectors v JOIN embedding_sets e ON e.set_id=v.set_id JOIN representation_targets r ON r.symbol_id=e.symbol_id AND r.model_fingerprint=e.model_fingerprint JOIN symbols s ON s.symbol_id=e.symbol_id" + contextJoin + " WHERE s.repository_id=$0 AND e.model_fingerprint=$1 AND ($2 IS NULL OR s.defining_context_id=$2) AND e.state='ready' AND e.input_revision=s.revision AND r.input_revision=s.revision AND r.representation_hash=e.representation_hash AND r.eligibility='eligible' AND v.dimensions=384 AND length(v.values_blob)=1536 AND (SELECT count(*) FROM vectors complete WHERE complete.set_id=e.set_id)=e.expected_chunks" + filter, parameters.ToArray());
        using var reader = command.ExecuteReader(); var scores = new VectorTopCandidates(); var scanned = 0;
        var bytes = new byte[LocalModel.Dimensions * 4];
        while (reader.Read())
        {
            if (++scanned > maximumChunks) throw new InvalidOperationException("VECTOR_CAPACITY_EXCEEDED");
            if ((scanned & 127) == 0) cancellationToken.ThrowIfCancellationRequested();
            if (reader.GetBytes(1, 0, bytes, 0, bytes.Length) != bytes.Length) continue;
            if (!VectorScoring.TryScore(bytes, query.Vector, out var score)) continue;
            if (scores.CanImprove(score)) scores.Add(reader.GetString(0), score);
        }
        cancellationToken.ThrowIfCancellationRequested();
        return scores.Results();
    }
    public void Dispose() { lock (queryLock) { cached?.Dispose(); cached = null; cachedFingerprint = null; foreach (var old in retired) old.Dispose(); retired.Clear(); } }
}
