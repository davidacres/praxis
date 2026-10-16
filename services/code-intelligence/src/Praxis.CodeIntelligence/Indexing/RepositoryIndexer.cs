using System.Text;
using Praxis.CodeIntelligence.Embeddings;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Praxis.CodeIntelligence.Storage;

namespace Praxis.CodeIntelligence.Indexing;

public sealed record RepositoryConfig(string? Manifest = null, string[]? Excludes = null);
public sealed record RepositoryRecord(string Id, string Root, long Generation, long QueryEpoch, string State, RepositoryConfig Config);
public sealed record IndexResult(string RepositoryId, long Generation, int Files, int Symbols, bool Changed);

public sealed class RepositoryIndexer(IndexDatabase database)
{
    private sealed record SavedAlias(string Id, string? ProjectId, string SymbolId, string Phrase, string Key, string Origin, long Enabled, string Created);

    public void AddAlias(string repositoryId, string symbolId, string phrase)
    {
        phrase = phrase.Trim(); if (phrase.Length is < 1 or > 2000) throw new ArgumentException("Alias phrase is invalid.");
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        if (connection.Scalar(transaction, "SELECT symbol_id FROM symbols WHERE repository_id=$0 AND symbol_id=$1 AND external=0", repositoryId, symbolId) is null)
            throw new KeyNotFoundException("SYMBOL_NOT_FOUND");
        connection.Execute(transaction, "INSERT INTO aliases VALUES($0,$1,NULL,$2,$3,$4,'manual',1,$5) ON CONFLICT DO NOTHING",
            "pci:alias:" + Guid.NewGuid().ToString("N"), repositoryId, symbolId, phrase, phrase.ToLowerInvariant(), DateTimeOffset.UtcNow.ToString("O"));
        connection.Execute(transaction, "UPDATE repositories SET query_epoch=query_epoch+1 WHERE repository_id=$0", repositoryId); transaction.Commit();
    }
    public string Register(string root, RepositoryConfig? config = null)
    {
        root = SourceFiles.CanonicalDirectory(root);
        if (config?.Manifest is not null) SourceFiles.Resolve(root, config.Manifest);
        foreach (var exclude in config?.Excludes ?? []) SourceFiles.Resolve(root, exclude.TrimEnd('/'));
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        var existing = connection.Scalar(transaction, "SELECT repository_id FROM repositories WHERE canonical_root=$0", root) as string;
        var id = existing ?? "pci:repo:" + Guid.NewGuid().ToString("N");
        if (existing is null)
            connection.Execute(transaction, "INSERT INTO repositories(repository_id,canonical_root,path_policy,config_json) VALUES($0,$1,$2,$3)",
                id, root, OperatingSystem.IsWindows() ? "caseInsensitive" : "caseSensitive", JsonSerializer.Serialize(config ?? new()));
        else if (config is not null)
        {
            var oldJson = (string)connection.Scalar(transaction, "SELECT config_json FROM repositories WHERE repository_id=$0", id)!;
            var old = JsonSerializer.Deserialize<RepositoryConfig>(oldJson)!;
            var merged = new RepositoryConfig(config.Manifest ?? old.Manifest, config.Excludes ?? old.Excludes);
            var newJson = JsonSerializer.Serialize(merged);
            if (newJson != oldJson)
            {
                Clear(connection, transaction, id); // Configuration/exclusion changes revoke all old derivatives immediately.
                connection.Execute(transaction, "UPDATE repositories SET config_json=$0,state='discovered',query_epoch=query_epoch+1 WHERE repository_id=$1", newJson, id);
            }
        }
        transaction.Commit(); return id;
    }

    public IReadOnlyList<RepositoryRecord> List()
    {
        using var connection = database.Open(readOnly: true); using var command = connection.Command(null,
            "SELECT repository_id,canonical_root,structural_generation,query_epoch,state,config_json FROM repositories ORDER BY canonical_root");
        using var reader = command.ExecuteReader(); var items = new List<RepositoryRecord>();
        while (reader.Read()) items.Add(new(reader.GetString(0), reader.GetString(1), reader.GetInt64(2), reader.GetInt64(3), reader.GetString(4),
            JsonSerializer.Deserialize<RepositoryConfig>(reader.GetString(5))!));
        return items;
    }

    public RepositoryRecord Get(string id) => List().SingleOrDefault(x => x.Id == id) ?? throw new KeyNotFoundException("REPOSITORY_NOT_FOUND");

    public void SetPaused(string id, bool paused)
    {
        using var connection = database.Open();
        if (connection.Execute(null, "UPDATE repositories SET state=$0,query_epoch=query_epoch+1 WHERE repository_id=$1", paused ? "paused" : "discovered", id) == 0)
            throw new KeyNotFoundException("REPOSITORY_NOT_FOUND");
    }

    public void Relocate(string id, string root, string? manifest = null)
    {
        var repository = Get(id); root = SourceFiles.CanonicalDirectory(root);
        if (manifest is not null) SourceFiles.Resolve(root, manifest);
        foreach (var exclude in repository.Config.Excludes ?? []) SourceFiles.Resolve(root, exclude.TrimEnd('/'));
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        var conflict = connection.Scalar(transaction, "SELECT repository_id FROM repositories WHERE canonical_root=$0 AND repository_id!=$1", root, id);
        if (conflict is not null) throw new ArgumentException("Destination root is already registered.");
        // Captured absolute project/import paths must be recaptured for a relocated root.
        // Only an explicitly supplied new manifest is retained; exclusion policy survives.
        Clear(connection, transaction, id);
        connection.Execute(transaction, "UPDATE repositories SET canonical_root=$0,config_json=$1,state=$2,query_epoch=query_epoch+1,last_reconciled_utc=NULL WHERE repository_id=$3",
            root, JsonSerializer.Serialize(new RepositoryConfig(manifest, repository.Config.Excludes)), repository.State == "paused" ? "paused" : "discovered", id);
        transaction.Commit();
    }

    public void Unregister(string id)
    {
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        Clear(connection, transaction, id);
        if (connection.Execute(transaction, "DELETE FROM repositories WHERE repository_id=$0", id) == 0) throw new KeyNotFoundException("REPOSITORY_NOT_FOUND");
        transaction.Commit();
    }

    public IndexResult Index(string id, CancellationToken cancellationToken = default, string? leaseToken = null, bool force = false)
    {
        try { return IndexCore(id, cancellationToken, leaseToken, force); }
        finally { MemoryPressure.RelieveAfterWork(); }
    }

    private IndexResult IndexCore(string id, CancellationToken cancellationToken, string? leaseToken, bool force)
    {
        var repository = Get(id);
        if (repository.State == "paused") throw new InvalidOperationException("INDEX_BUSY: repository is paused.");
        IReadOnlyList<SourceInput> sources; RepositoryAnalysis analysis; string snapshotHash;
        try
        {
            sources = SourceScanner.Scan(repository.Root, repository.Config.Excludes ?? [], cancellationToken);
            PassiveManifest? manifest = null; IndexedDiagnostic? manifestDiagnostic = null; string? manifestHash = null;
            if (repository.Config.Manifest is not null)
            {
                var authored = sources;
                try
                {
                    manifestHash = SourceFiles.Read(repository.Root, repository.Config.Manifest, cancellationToken).Hash; manifest = PassiveManifest.Read(repository.Root, repository.Config.Manifest);
                    var combined = sources.ToDictionary(source => source.Path, StringComparer.Ordinal);
                    foreach (var path in manifest.Projects.SelectMany(project => project.SupportSources ?? []).Distinct(StringComparer.Ordinal))
                    {
                        if (SourceScanner.IsExcluded(path, repository.Config.Excludes ?? [])) throw new IOException("Semantic support source is explicitly excluded.");
                        combined[path] = SourceFiles.Read(repository.Root, path, cancellationToken) with { Role = "semanticSupport" };
                    }
                    sources = combined.Values.OrderBy(source => source.Path, StringComparer.Ordinal).ToArray();
                    if (manifest.Projects.SelectMany(project => project.Sources.Concat(project.SupportSources ?? [])).Any(path => !combined.ContainsKey(path)))
                        throw new IOException("Passive source membership is stale or excluded.");
                    foreach (var metadata in manifest.Projects.SelectMany(project => project.Metadata ?? []).Distinct())
                        if (SourceFiles.Hash(PassiveManifest.ReadExternal(metadata.Path)) != metadata.ContentHash) throw new IOException("Captured metadata is stale.");
                    if (sources.Count > 25_000 || sources.Sum(source => (long)source.Bytes.Length) > 256L * 1024 * 1024) throw new IOException("INPUT_TOO_LARGE: source snapshot exceeds its limit.");
                }
                catch (Exception ex) when (ex is IOException or ArgumentException or JsonException)
                { manifest = null; sources = authored; manifestDiagnostic = new("", null, "INDEX_STALE", "warning", "Passive context is unavailable or stale; indexed source using syntax-only analysis.", null); }
            }
            var confirmed = SourceScanner.Scan(repository.Root, repository.Config.Excludes ?? [], cancellationToken);
            var supportPaths = sources.Where(source => source.Role == "semanticSupport").Select(source => source.Path).ToHashSet(StringComparer.Ordinal);
            if (!sources.Where(source => source.Role == "searchableSource").Select(s => (s.Path, s.Hash)).SequenceEqual(confirmed.Where(source => !supportPaths.Contains(source.Path)).Select(s => (s.Path, s.Hash)))) throw new IOException("INDEX_STALE: source snapshot changed during analysis.");
            foreach (var source in sources.Where(source => source.Role == "semanticSupport"))
                if (SourceFiles.Read(repository.Root, source.Path, cancellationToken).Hash != source.Hash) throw new IOException("INDEX_STALE: semantic support changed during analysis.");
            if (manifestHash is not null && SourceFiles.Read(repository.Root, repository.Config.Manifest!, cancellationToken).Hash != manifestHash)
                throw new IOException("INDEX_STALE: manifest changed during analysis.");
            if (manifest is not null)
            {
                _ = PassiveManifest.Read(repository.Root, repository.Config.Manifest!);
                foreach (var metadata in manifest.Projects.SelectMany(project => project.Metadata ?? []).Distinct())
                    if (SourceFiles.Hash(PassiveManifest.ReadExternal(metadata.Path)) != metadata.ContentHash) throw new IOException("INDEX_STALE: reference changed during analysis.");
            }
            snapshotHash = SourceFiles.Hash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
            {
                Adapter = RoslynAnalyzer.AdapterVersion, ManifestHash = manifestHash, Manifest = manifest, repository.Config,
                Sources = sources.Select(source => new { source.Path, source.Hash, source.Role }).OrderBy(source => source.Path, StringComparer.Ordinal)
            })));
            if (!force && TryUnchanged(repository, sources.Count, snapshotHash, cancellationToken, leaseToken) is IndexResult unchanged) return unchanged;
            analysis = new RoslynAnalyzer().Analyze(id, sources, manifest, cancellationToken);
            if (manifestDiagnostic is not null) analysis = analysis with { Diagnostics = [.. analysis.Diagnostics, manifestDiagnostic] };
            // Analysis can be lengthy. Verify inputs again before any structural publication.
            var afterAnalysis = SourceScanner.Scan(repository.Root, repository.Config.Excludes ?? [], cancellationToken);
            if (!sources.Where(source => source.Role == "searchableSource").Select(source => (source.Path, source.Hash))
                .SequenceEqual(afterAnalysis.Where(source => !supportPaths.Contains(source.Path)).Select(source => (source.Path, source.Hash))))
                throw new IOException("INDEX_STALE: source changed during analysis.");
            foreach (var source in sources.Where(source => source.Role == "semanticSupport"))
                if (SourceFiles.Read(repository.Root, source.Path, cancellationToken).Hash != source.Hash) throw new IOException("INDEX_STALE: support source changed during analysis.");
            if (manifestHash is not null && SourceFiles.Read(repository.Root, repository.Config.Manifest!, cancellationToken).Hash != manifestHash)
                throw new IOException("INDEX_STALE: manifest changed during analysis.");
            if (manifest is not null)
            {
                _ = PassiveManifest.Read(repository.Root, repository.Config.Manifest!);
                foreach (var metadata in manifest.Projects.SelectMany(project => project.Metadata ?? []).Distinct())
                    if (SourceFiles.Hash(PassiveManifest.ReadExternal(metadata.Path)) != metadata.ContentHash) throw new IOException("INDEX_STALE: reference changed during analysis.");
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or DecoderFallbackException)
        {
            using var failed = database.Open();
            failed.Execute(null, "UPDATE repositories SET state='unknown',query_epoch=query_epoch+1 WHERE repository_id=$0", id);
            throw;
        }
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        if (leaseToken is not null) Host.DurableScheduler.AssertLease(connection, transaction, leaseToken);
        if (Convert.ToInt64(connection.Scalar(transaction, "SELECT query_epoch FROM repositories WHERE repository_id=$0", id)) != repository.QueryEpoch)
            throw new InvalidOperationException("INDEX_STALE: repository state changed during analysis.");
        var oldHash = string.Join("|", ReadContextHashes(connection, transaction, id));
        var newHash = string.Join("|", analysis.Contexts.OrderBy(c => c.Id, StringComparer.Ordinal).Select(c => c.Hash));
        if (!force && oldHash == newHash && repository.Generation > 0)
        {
            connection.Execute(transaction, "UPDATE contexts SET options_json=$0 WHERE project_id IN(SELECT project_id FROM projects WHERE repository_id=$1)", JsonSerializer.Serialize(new { snapshotHash }), id);
            connection.Execute(transaction, "UPDATE repositories SET state='ready',last_reconciled_utc=$0 WHERE repository_id=$1", DateTimeOffset.UtcNow.ToString("O"), id);
            cancellationToken.ThrowIfCancellationRequested(); transaction.Commit(); return new(id, repository.Generation, sources.Count, analysis.Symbols.Count, false);
        }
        // Reuse only complete current-profile sets whose exact representation is unchanged.
        var reusable = EmbeddingReuse.Capture(connection, transaction, id, cancellationToken);
        // Keep parent rows only when all structural keys survive. Analysis is still
        // complete; additions/removals and forced rebuilds use full replacement.
        var retainedFiles = force ? null : MatchingStructure(connection, transaction, id, sources, analysis);
        var retain = retainedFiles is not null;
        var aliases = new List<SavedAlias>();
        if (!retain)
        using (var command = connection.Command(transaction, "SELECT alias_id,project_id,symbol_id,phrase,phrase_key,origin,enabled,created_utc FROM aliases WHERE repository_id=$0", id))
        using (var reader = command.ExecuteReader()) while (reader.Read()) aliases.Add(new(reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.GetInt64(6), reader.GetString(7)));
        using var batch = new SqlBatch(connection, transaction);
        var retainedLocations = new HashSet<string>(StringComparer.Ordinal);
        var retainedOccurrences = new HashSet<string>(StringComparer.Ordinal);
        if (retain)
        {
            (retainedLocations, retainedOccurrences) = RetainMatchingContributions(connection, transaction, batch, id, analysis, cancellationToken);
            ClearContributions(connection, transaction, id);
        }
        else Clear(connection, transaction, id);
        var generation = repository.Generation + 1;
        var fileIds = retainedFiles ?? sources.ToDictionary(s => s.Path, _ => "pci:file:" + Guid.NewGuid().ToString("N"), StringComparer.Ordinal);
        foreach (var source in sources)
            batch.Execute("INSERT INTO files(file_id,repository_id,relative_path,path_key,observed_hash,size_bytes,language,role,state) VALUES($0,$1,$2,$3,$4,$5,'csharp',$6,'ready') ON CONFLICT(file_id) DO UPDATE SET observed_hash=excluded.observed_hash,size_bytes=excluded.size_bytes,role=excluded.role,state='ready'",
                fileIds[source.Path], id, source.Path, OperatingSystem.IsWindows() ? source.Path.ToUpperInvariant() : source.Path, source.Hash, source.Bytes.Length, source.Role);
        foreach (var context in analysis.Contexts)
        {
            var projectId = Identity.Id("pci:project:", id, context.Key);
            batch.Execute("INSERT INTO projects VALUES($0,$1,$2,$3,'csharp') ON CONFLICT(project_id) DO UPDATE SET relative_path=excluded.relative_path", projectId, id, context.Key, context.ProjectPath);
            batch.Execute("INSERT INTO contexts(context_id,project_id,slot_key,context_hash,api_hash,adapter_version,options_json,desired_revision,published_revision,state,resolution,capabilities_json) VALUES($0,$1,$2,$3,$3,$7,$8,$4,$4,'ready',$5,$6) ON CONFLICT(context_id) DO UPDATE SET context_hash=excluded.context_hash,api_hash=excluded.api_hash,adapter_version=excluded.adapter_version,options_json=excluded.options_json,desired_revision=excluded.desired_revision,published_revision=excluded.published_revision,state=excluded.state,resolution=excluded.resolution,capabilities_json=excluded.capabilities_json",
                context.Id, projectId, context.Key, context.Hash, generation, context.Resolution,
                JsonSerializer.Serialize(context.Resolution == "syntaxOnly" ? new[] { "declarations", "lexical" } : new[] { "declarations", "lexical", "calls", "references", "accesses", "typeDependencies" }), RoslynAnalyzer.AdapterVersion, JsonSerializer.Serialize(new { snapshotHash }));
            foreach (var source in context.Sources)
                batch.Execute("INSERT INTO context_files VALUES($0,$1,$2,$3) ON CONFLICT(context_id,file_id) DO UPDATE SET analysed_hash=excluded.analysed_hash,generation=excluded.generation", context.Id, fileIds[source.Path], source.Hash, generation);
        }
        foreach (var symbol in analysis.Symbols)
        {
            batch.Execute("INSERT INTO symbols VALUES($0,$1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(symbol_id) DO UPDATE SET defining_context_id=excluded.defining_context_id,identity_key=excluded.identity_key,descriptor_json=excluded.descriptor_json,kind=excluded.kind,name=excluded.name,qualified_name=excluded.qualified_name,signature=excluded.signature,revision=excluded.revision,external=excluded.external,resolution=excluded.resolution,containment_id=excluded.containment_id", symbol.Id, id,
                symbol.External ? null : symbol.ContextId, symbol.Identity, symbol.Kind, symbol.Name, symbol.QualifiedName,
                symbol.Signature, symbol.Revision, symbol.External ? 1 : 0, symbol.Resolution, symbol.ContainerId);
            foreach (var location in symbol.Locations)
                if (!retainedLocations.Contains(location.Id)) batch.Execute("INSERT INTO locations VALUES($0,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'declaration')", location.Id, symbol.Id,
                    location.ContextId, fileIds[location.FilePath], location.Hash, location.Start, location.End,
                    location.Range.Start.Line, location.Range.Start.Character, location.Range.End.Line, location.Range.End.Character);
            if (!symbol.External)
                batch.Execute("INSERT INTO search_documents(symbol_id,input_revision,name,signature,documentation,description) VALUES($0,$1,$2,$3,$4,$5) ON CONFLICT(symbol_id) DO UPDATE SET input_revision=excluded.input_revision,name=excluded.name,signature=excluded.signature,documentation=excluded.documentation,description=excluded.description",
                    symbol.Id, symbol.Revision, SearchTerms(symbol.QualifiedName), SearchTerms(symbol.Signature), symbol.Documentation, $"{symbol.Kind} {symbol.QualifiedName}. {symbol.Signature}");
        }
        EmbeddingReuse.Publish(connection, transaction, analysis, sources, reusable, cancellationToken, batch, retain);
        if (retain)
        {
            // Every old set was made stale before updating symbol revisions. Only
            // validated, representation-equivalent sets were made ready again.
            batch.Execute("DELETE FROM embedding_sets WHERE symbol_id IN(SELECT symbol_id FROM symbols WHERE repository_id=$0) AND state!='ready'", id);
            batch.Execute("DELETE FROM representation_targets WHERE symbol_id IN(SELECT symbol_id FROM symbols WHERE repository_id=$0) AND NOT EXISTS(SELECT 1 FROM embedding_sets e WHERE e.symbol_id=representation_targets.symbol_id AND e.model_fingerprint=representation_targets.model_fingerprint)", id);
        }
        foreach (var alias in aliases)
            if (connection.Scalar(transaction, "SELECT symbol_id FROM symbols WHERE symbol_id=$0", alias.SymbolId) is not null
                && (alias.ProjectId is null || connection.Scalar(transaction, "SELECT project_id FROM projects WHERE project_id=$0", alias.ProjectId) is not null))
                batch.Execute("INSERT INTO aliases VALUES($0,$1,$2,$3,$4,$5,$6,$7,$8)", alias.Id, id, alias.ProjectId, alias.SymbolId, alias.Phrase, alias.Key, alias.Origin, alias.Enabled, alias.Created);
        foreach (var call in analysis.Calls.Concat(analysis.Relationships))
        {
            if (retainedOccurrences.Contains(call.Id)) continue;
            batch.Execute("INSERT INTO occurrences(occurrence_id,context_id,file_id,owner_symbol_id,target_symbol_id,content_hash,start_offset,end_offset,range_json,resolution) VALUES($0,$1,$2,$3,$4,$5,$6,$7,$8,$9)",
                call.Id, call.ContextId, fileIds[call.FilePath], call.OwnerId, call.TargetId, call.Hash, call.Start, call.End, JsonSerializer.Serialize(call.Range), call.Resolution);
            if (call.TargetId is not null)
                batch.Execute("INSERT INTO edges VALUES($0,$1,$2,$3,$4,$5,$9,'compiler',$6,$7,$8)",
                    Identity.Id("pci:edge:", call.Id, call.TargetId), call.ContextId, fileIds[call.FilePath], call.OwnerId, call.TargetId, call.Id,
                    call.Resolution, call.Hash, call.Id, call.Kind);
        }
        foreach (var dependency in analysis.ConfiguredDependencies)
        {
            cancellationToken.ThrowIfCancellationRequested();
            batch.Execute("INSERT INTO edges VALUES($0,$1,NULL,$2,$3,NULL,'depends_on','compiler',$4,$5,$6)",
                dependency.Id, dependency.ContextId, dependency.OwnerId, dependency.TargetId, dependency.Resolution,
                dependency.InputRevision, dependency.ReferenceIdentity);
            if (dependency.TargetContextId is not null)
                batch.Execute("INSERT INTO context_dependencies VALUES($0,$1,$2)", dependency.ContextId, dependency.TargetContextId, dependency.RequiredContextHash);
        }
        foreach (var diagnostic in analysis.Diagnostics)
            batch.Execute("INSERT INTO diagnostics VALUES($0,$1,$2,$3,$4,$5,$6,$7,$8)", "pci:diag:" + Guid.NewGuid().ToString("N"), id,
                diagnostic.ContextId.Length == 0 ? null : diagnostic.ContextId, diagnostic.FilePath is null ? null : fileIds.GetValueOrDefault(diagnostic.FilePath),
                diagnostic.Code, diagnostic.Severity, diagnostic.Message, diagnostic.Range is null ? null : JsonSerializer.Serialize(diagnostic.Range), generation);
        batch.Execute("UPDATE repositories SET structural_generation=$0,desired_revision=$0,query_epoch=query_epoch+1,state='ready',last_reconciled_utc=$1 WHERE repository_id=$2",
            generation, DateTimeOffset.UtcNow.ToString("O"), id);
        // Structural facts and refresh work commit together: a crash cannot strand an active profile without a job.
        batch.Execute("UPDATE jobs SET state='obsolete',lease_token=NULL,lease_owner=NULL,lease_until_utc=NULL WHERE repository_id=$0 AND kind='embed' AND state IN('pending','leased')", id);
        var profiles = new List<string>();
        using (var command = connection.Command(transaction, "SELECT model_fingerprint FROM repository_models WHERE repository_id=$0 AND state IN('active','building')", id))
        using (var reader = command.ExecuteReader()) while (reader.Read()) profiles.Add(reader.GetString(0));
        foreach (var profile in profiles)
        {
            var active = connection.Scalar(transaction, "SELECT state FROM repository_models WHERE repository_id=$0 AND model_fingerprint=$1", id, profile) as string == "active";
            var eligible = Convert.ToInt64(connection.Scalar(transaction, "SELECT count(*) FROM symbols WHERE repository_id=$0 AND external=0", id));
            var covered = Convert.ToInt64(connection.Scalar(transaction, "SELECT count(*) FROM embedding_sets e JOIN symbols s ON s.symbol_id=e.symbol_id WHERE s.repository_id=$0 AND e.model_fingerprint=$1 AND e.state='ready' AND e.input_revision=s.revision", id, profile));
            if (active && eligible == covered) continue;
            var key = Identity.Id("", profile, generation);
            batch.Execute("INSERT INTO jobs(job_id,repository_id,kind,input_key,payload_json,desired_revision,state,available_utc) VALUES($0,$1,'embed',$2,$3,$4,'pending',$5) ON CONFLICT(repository_id,kind,input_key) DO NOTHING",
                Identity.Id("pci:job:", id, "embed", key), id, key, JsonSerializer.Serialize(new { fingerprint = profile }), generation, DateTimeOffset.UtcNow.ToString("O"));
        }
        if (leaseToken is not null) Host.DurableScheduler.AssertLease(connection, transaction, leaseToken);
        cancellationToken.ThrowIfCancellationRequested(); transaction.Commit();
        return new(id, generation, sources.Count, analysis.Symbols.Count, true);
    }

    private IndexResult? TryUnchanged(RepositoryRecord repository, int files, string snapshotHash, CancellationToken cancellationToken, string? leaseToken)
    {
        if (repository.Generation == 0) return null;
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        if (leaseToken is not null) Host.DurableScheduler.AssertLease(connection, transaction, leaseToken);
        if (Convert.ToInt64(connection.Scalar(transaction, "SELECT query_epoch FROM repositories WHERE repository_id=$0", repository.Id)) != repository.QueryEpoch)
            throw new InvalidOperationException("INDEX_STALE: repository changed during input validation.");
        var total = Convert.ToInt64(connection.Scalar(transaction, "SELECT count(*) FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.repository_id=$0", repository.Id));
        var matching = Convert.ToInt64(connection.Scalar(transaction,
            "SELECT count(*) FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.repository_id=$0 AND c.adapter_version=$1 AND json_extract(c.options_json,'$.snapshotHash')=$2",
            repository.Id, RoslynAnalyzer.AdapterVersion, snapshotHash));
        if (total == 0 || total != matching) return null;
        var symbols = Convert.ToInt32(connection.Scalar(transaction, "SELECT count(*) FROM symbols WHERE repository_id=$0", repository.Id));
        connection.Execute(transaction, "UPDATE repositories SET state='ready',last_reconciled_utc=$0 WHERE repository_id=$1", DateTimeOffset.UtcNow.ToString("O"), repository.Id);
        if (leaseToken is not null) Host.DurableScheduler.AssertLease(connection, transaction, leaseToken);
        cancellationToken.ThrowIfCancellationRequested(); transaction.Commit();
        return new(repository.Id, repository.Generation, files, symbols, false);
    }

    private static Dictionary<string, string>? MatchingStructure(SqliteConnection connection, SqliteTransaction transaction,
        string repositoryId, IReadOnlyList<SourceInput> sources, RepositoryAnalysis analysis)
    {
        var files = new Dictionary<string, string>(StringComparer.Ordinal);
        using (var command = connection.Command(transaction, "SELECT relative_path,file_id FROM files WHERE repository_id=$0", repositoryId))
        using (var reader = command.ExecuteReader()) while (reader.Read()) files.Add(reader.GetString(0), reader.GetString(1));
        if (!files.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(sources.Select(source => source.Path))) return null;
        bool SameKeys(string sql, IEnumerable<string> expected)
        {
            var actual = new HashSet<string>(StringComparer.Ordinal);
            using var command = connection.Command(transaction, sql, repositoryId); using var reader = command.ExecuteReader();
            while (reader.Read()) actual.Add(reader.GetString(0));
            return actual.SetEquals(expected);
        }
        if (!SameKeys("SELECT c.context_id FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.repository_id=$0", analysis.Contexts.Select(context => context.Id))
            || !SameKeys("SELECT symbol_id FROM symbols WHERE repository_id=$0", analysis.Symbols.Select(symbol => symbol.Id))) return null;
        var membership = new HashSet<(string Context, string File)>();
        using (var command = connection.Command(transaction, "SELECT cf.context_id,cf.file_id FROM context_files cf JOIN files f ON f.file_id=cf.file_id WHERE f.repository_id=$0", repositoryId))
        using (var reader = command.ExecuteReader()) while (reader.Read()) membership.Add((reader.GetString(0), reader.GetString(1)));
        if (!membership.SetEquals(analysis.Contexts.SelectMany(context => context.Sources.Select(source => (context.Id, files[source.Path]))))) return null;
        return files;
    }

    private static (HashSet<string> Locations, HashSet<string> Occurrences) RetainMatchingContributions(
        SqliteConnection connection, SqliteTransaction transaction, SqlBatch batch, string repositoryId, RepositoryAnalysis analysis, CancellationToken cancellationToken)
    {
        var expectedLocations = analysis.Symbols.SelectMany(symbol => symbol.Locations.Select(location => (symbol.Id, Location: location)))
            .ToDictionary(entry => entry.Location.Id, StringComparer.Ordinal);
        var locations = new HashSet<string>(StringComparer.Ordinal); var removeLocations = new List<string>();
        using (var command = connection.Command(transaction, "SELECT l.location_id,l.symbol_id,l.context_id,f.relative_path,l.content_hash,l.start_offset,l.end_offset,l.start_line,l.start_character,l.end_line,l.end_character,l.role FROM locations l JOIN files f ON f.file_id=l.file_id WHERE f.repository_id=$0", repositoryId))
        using (var reader = command.ExecuteReader())
            while (reader.Read())
            {
                cancellationToken.ThrowIfCancellationRequested();
                var id = reader.GetString(0);
                var location = new IndexedLocation(id, reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.GetInt32(5), reader.GetInt32(6),
                    new(new(reader.GetInt32(7), reader.GetInt32(8)), new(reader.GetInt32(9), reader.GetInt32(10))));
                if (expectedLocations.TryGetValue(id, out var expected) && expected.Id == reader.GetString(1)
                    && expected.Location == location && reader.GetString(11) == "declaration") locations.Add(id);
                else removeLocations.Add(id);
            }
        foreach (var id in removeLocations) batch.Execute("DELETE FROM locations WHERE location_id=$0", id);

        var expectedCalls = analysis.Calls.Concat(analysis.Relationships).ToDictionary(call => call.Id, StringComparer.Ordinal);
        var occurrences = new HashSet<string>(StringComparer.Ordinal); var removeCalls = new HashSet<string>(StringComparer.Ordinal);
        var visited = new HashSet<string>(StringComparer.Ordinal);
        using (var command = connection.Command(transaction,
            "SELECT o.occurrence_id,o.context_id,f.relative_path,o.owner_symbol_id,o.target_symbol_id,o.content_hash,o.start_offset,o.end_offset,o.range_json,o.resolution," +
            "e.edge_id,e.kind,e.provenance,e.resolution,e.input_revision,e.evidence_key,e.source_symbol_id,e.target_symbol_id,e.owner_context_id,e.owner_file_id,o.file_id " +
            "FROM occurrences o JOIN files f ON f.file_id=o.file_id LEFT JOIN edges e ON e.occurrence_id=o.occurrence_id WHERE f.repository_id=$0", repositoryId))
        using (var reader = command.ExecuteReader())
            while (reader.Read())
            {
                cancellationToken.ThrowIfCancellationRequested();
                var id = reader.GetString(0);
                var same = visited.Add(id) && expectedCalls.TryGetValue(id, out var expected)
                    && expected.ContextId == reader.GetString(1) && expected.FilePath == reader.GetString(2)
                    && expected.OwnerId == reader.GetString(3) && expected.TargetId == (reader.IsDBNull(4) ? null : reader.GetString(4))
                    && expected.Hash == reader.GetString(5) && expected.Start == reader.GetInt32(6) && expected.End == reader.GetInt32(7)
                    && JsonSerializer.Serialize(expected.Range) == reader.GetString(8) && expected.Resolution == reader.GetString(9)
                    && (expected.TargetId is null ? reader.IsDBNull(10)
                        : !reader.IsDBNull(10) && reader.GetString(10) == Identity.Id("pci:edge:", id, expected.TargetId)
                            && reader.GetString(11) == expected.Kind && reader.GetString(12) == "compiler"
                            && reader.GetString(13) == expected.Resolution && reader.GetString(14) == expected.Hash && reader.GetString(15) == id
                            && reader.GetString(16) == expected.OwnerId && reader.GetString(17) == expected.TargetId
                            && reader.GetString(18) == expected.ContextId && !reader.IsDBNull(19) && reader.GetString(19) == reader.GetString(20));
                if (same) occurrences.Add(id);
                else { occurrences.Remove(id); removeCalls.Add(id); }
            }
        foreach (var id in removeCalls) batch.Execute("DELETE FROM occurrences WHERE occurrence_id=$0", id);
        // Captured configuration edges are replaced atomically from the new compiler inputs.
        batch.Execute("DELETE FROM edges WHERE occurrence_id IS NULL AND owner_context_id IN(SELECT c.context_id FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.repository_id=$0)", repositoryId);
        return (locations, occurrences);
    }

    private static void ClearContributions(SqliteConnection connection, SqliteTransaction transaction, string id)
    {
        const string contexts = "SELECT c.context_id FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.repository_id=$0";
        connection.Execute(transaction, "UPDATE embedding_sets SET state='stale' WHERE symbol_id IN(SELECT symbol_id FROM symbols WHERE repository_id=$0)", id);
        connection.Execute(transaction, "DELETE FROM context_dependencies WHERE caller_context_id IN(" + contexts + ") OR target_context_id IN(" + contexts + ")", id);
        connection.Execute(transaction, "DELETE FROM project_inputs WHERE context_id IN(" + contexts + ")", id);
        connection.Execute(transaction, "DELETE FROM descriptions WHERE symbol_id IN(SELECT symbol_id FROM symbols WHERE repository_id=$0)", id);
        connection.Execute(transaction, "DELETE FROM jobs WHERE repository_id=$0 AND (context_id IS NOT NULL OR symbol_id IS NOT NULL)", id);
        connection.Execute(transaction, "DELETE FROM diagnostics WHERE repository_id=$0", id);
    }

    private static IEnumerable<string> ReadContextHashes(SqliteConnection connection, SqliteTransaction transaction, string id)
    {
        using var command = connection.Command(transaction, "SELECT context_hash FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.repository_id=$0 ORDER BY context_id", id);
        using var reader = command.ExecuteReader(); while (reader.Read()) yield return reader.GetString(0);
    }
    private static void Clear(SqliteConnection connection, SqliteTransaction transaction, string id)
    {
        connection.Execute(transaction, "UPDATE embedding_sets SET state='stale' WHERE symbol_id IN(SELECT symbol_id FROM symbols WHERE repository_id=$0)", id);
        // Remove owned relationships in batches before symbol cascades. Otherwise each
        // deleted target nulls surviving occurrences that this publication will delete too.
        connection.Execute(transaction, "DELETE FROM edges WHERE owner_context_id IN(SELECT c.context_id FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.repository_id=$0)", id);
        connection.Execute(transaction, "DELETE FROM occurrences WHERE context_id IN(SELECT c.context_id FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.repository_id=$0)", id);
        connection.Execute(transaction, "DELETE FROM symbols WHERE repository_id=$0", id);
        connection.Execute(transaction, "DELETE FROM projects WHERE repository_id=$0", id);
        connection.Execute(transaction, "DELETE FROM files WHERE repository_id=$0", id);
        connection.Execute(transaction, "DELETE FROM diagnostics WHERE repository_id=$0", id);
    }
    // Keep original identifiers for exact token queries, and append readable
    // terms for acronym, namespace, underscore and parameter-type searches.
    private static string SearchTerms(string text)
    {
        var output = new StringBuilder(text).Append(' ');
        for (var i = 0; i < text.Length; i++)
        {
            var current = text[i];
            if (!char.IsLetterOrDigit(current)) { output.Append(' '); continue; }
            if (i > 0 && char.IsUpper(current)
                && (char.IsLower(text[i - 1]) || char.IsDigit(text[i - 1])
                    || (char.IsUpper(text[i - 1]) && i + 1 < text.Length && char.IsLower(text[i + 1]))))
                output.Append(' ');
            output.Append(current);
        }
        return output.ToString();
    }
}
