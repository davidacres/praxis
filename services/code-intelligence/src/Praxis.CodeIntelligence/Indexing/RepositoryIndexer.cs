using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Praxis.CodeIntelligence.Storage;

namespace Praxis.CodeIntelligence.Indexing;

public sealed record RepositoryConfig(string? Manifest = null, string[]? Excludes = null);
public sealed record RepositoryRecord(string Id, string Root, long Generation, long QueryEpoch, string State, RepositoryConfig Config);
public sealed record IndexResult(string RepositoryId, long Generation, int Files, int Symbols, bool Changed);

public sealed class RepositoryIndexer(IndexDatabase database)
{
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

    public void Unregister(string id)
    {
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        Clear(connection, transaction, id);
        if (connection.Execute(transaction, "DELETE FROM repositories WHERE repository_id=$0", id) == 0) throw new KeyNotFoundException("REPOSITORY_NOT_FOUND");
        transaction.Commit();
    }

    public IndexResult Index(string id, CancellationToken cancellationToken = default)
    {
        var repository = Get(id);
        if (repository.State == "paused") throw new InvalidOperationException("INDEX_BUSY: repository is paused.");
        IReadOnlyList<SourceInput> sources; RepositoryAnalysis analysis;
        try
        {
            sources = SourceScanner.Scan(repository.Root, repository.Config.Excludes ?? [], cancellationToken);
            PassiveManifest? manifest = null; IndexedDiagnostic? manifestDiagnostic = null; string? manifestHash = null;
            if (repository.Config.Manifest is not null)
            {
                try { manifestHash = SourceFiles.Read(repository.Root, repository.Config.Manifest, cancellationToken).Hash; manifest = PassiveManifest.Read(repository.Root, repository.Config.Manifest); }
                catch (Exception ex) when (ex is IOException or ArgumentException or JsonException)
                { manifestDiagnostic = new("", null, "INDEX_STALE", "warning", "Passive context is unavailable or stale; indexed source using syntax-only analysis.", null); }
            }
            analysis = new RoslynAnalyzer().Analyze(id, sources, manifest, cancellationToken);
            if (manifestDiagnostic is not null) analysis = analysis with { Diagnostics = [.. analysis.Diagnostics, manifestDiagnostic] };
            var confirmed = SourceScanner.Scan(repository.Root, repository.Config.Excludes ?? [], cancellationToken);
            if (!sources.Select(s => (s.Path, s.Hash)).SequenceEqual(confirmed.Select(s => (s.Path, s.Hash)))) throw new IOException("INDEX_STALE: source snapshot changed during analysis.");
            if (manifestHash is not null && SourceFiles.Read(repository.Root, repository.Config.Manifest!, cancellationToken).Hash != manifestHash)
                throw new IOException("INDEX_STALE: manifest changed during analysis.");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or DecoderFallbackException)
        {
            using var failed = database.Open();
            failed.Execute(null, "UPDATE repositories SET state='unknown',query_epoch=query_epoch+1 WHERE repository_id=$0", id);
            throw;
        }
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        if (Convert.ToInt64(connection.Scalar(transaction, "SELECT query_epoch FROM repositories WHERE repository_id=$0", id)) != repository.QueryEpoch)
            throw new InvalidOperationException("INDEX_STALE: repository state changed during analysis.");
        var oldHash = string.Join("|", ReadContextHashes(connection, transaction, id));
        var newHash = string.Join("|", analysis.Contexts.OrderBy(c => c.Id, StringComparer.Ordinal).Select(c => c.Hash));
        if (oldHash == newHash && repository.Generation > 0)
        {
            connection.Execute(transaction, "UPDATE repositories SET state='ready',last_reconciled_utc=$0 WHERE repository_id=$1", DateTimeOffset.UtcNow.ToString("O"), id);
            transaction.Commit(); return new(id, repository.Generation, sources.Count, analysis.Symbols.Count, false);
        }
        // Conservatively republish every context. This intentionally claims no affected-file optimization.
        Clear(connection, transaction, id);
        var generation = repository.Generation + 1;
        var fileIds = sources.ToDictionary(s => s.Path, _ => "pci:file:" + Guid.NewGuid().ToString("N"), StringComparer.Ordinal);
        foreach (var source in sources)
            connection.Execute(transaction, "INSERT INTO files(file_id,repository_id,relative_path,path_key,observed_hash,size_bytes,language,role,state) VALUES($0,$1,$2,$3,$4,$5,'csharp','searchableSource','ready')",
                fileIds[source.Path], id, source.Path, OperatingSystem.IsWindows() ? source.Path.ToUpperInvariant() : source.Path, source.Hash, source.Bytes.Length);
        foreach (var context in analysis.Contexts)
        {
            var projectId = Identity.Id("pci:project:", id, context.Key);
            connection.Execute(transaction, "INSERT INTO projects VALUES($0,$1,$2,$3,'csharp')", projectId, id, context.Key, context.ProjectPath);
            connection.Execute(transaction, "INSERT INTO contexts(context_id,project_id,slot_key,context_hash,api_hash,adapter_version,options_json,desired_revision,published_revision,state,resolution,capabilities_json) VALUES($0,$1,$2,$3,$3,'roslyn-5.9/v1','{}',$4,$4,'ready',$5,$6)",
                context.Id, projectId, context.Key, context.Hash, generation, context.Resolution,
                JsonSerializer.Serialize(context.Resolution == "syntaxOnly" ? new[] { "declarations", "lexical" } : new[] { "declarations", "lexical", "calls" }));
            foreach (var source in context.Sources)
                connection.Execute(transaction, "INSERT INTO context_files VALUES($0,$1,$2,$3)", context.Id, fileIds[source.Path], source.Hash, generation);
        }
        foreach (var symbol in analysis.Symbols)
        {
            connection.Execute(transaction, "INSERT INTO symbols VALUES($0,$1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11)", symbol.Id, id,
                symbol.External ? null : symbol.ContextId, symbol.Identity, symbol.Kind, symbol.Name, symbol.QualifiedName,
                symbol.Signature, symbol.Revision, symbol.External ? 1 : 0, symbol.Resolution, symbol.ContainerId);
            foreach (var location in symbol.Locations)
                connection.Execute(transaction, "INSERT INTO locations VALUES($0,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'declaration')", location.Id, symbol.Id,
                    location.ContextId, fileIds[location.FilePath], location.Hash, location.Start, location.End,
                    location.Range.Start.Line, location.Range.Start.Character, location.Range.End.Line, location.Range.End.Character);
            if (!symbol.External)
                connection.Execute(transaction, "INSERT INTO search_documents(symbol_id,input_revision,name,signature,documentation,description) VALUES($0,$1,$2,$3,$4,$5)",
                    symbol.Id, symbol.Revision, symbol.QualifiedName + " " + SplitCamel(symbol.Name), symbol.Signature, symbol.Documentation, $"{symbol.Kind} {symbol.QualifiedName}. {symbol.Signature}");
        }
        foreach (var call in analysis.Calls)
        {
            connection.Execute(transaction, "INSERT INTO occurrences(occurrence_id,context_id,file_id,owner_symbol_id,target_symbol_id,content_hash,start_offset,end_offset,range_json,resolution) VALUES($0,$1,$2,$3,$4,$5,$6,$7,$8,$9)",
                call.Id, call.ContextId, fileIds[call.FilePath], call.OwnerId, call.TargetId, call.Hash, call.Start, call.End, JsonSerializer.Serialize(call.Range), call.Resolution);
            if (call.TargetId is not null)
                connection.Execute(transaction, "INSERT INTO edges VALUES($0,$1,$2,$3,$4,$5,'calls','compiler',$6,$7,$8)",
                    Identity.Id("pci:edge:", call.Id, call.TargetId), call.ContextId, fileIds[call.FilePath], call.OwnerId, call.TargetId, call.Id,
                    call.Resolution, call.Hash, call.Id);
        }
        foreach (var diagnostic in analysis.Diagnostics)
            connection.Execute(transaction, "INSERT INTO diagnostics VALUES($0,$1,$2,$3,$4,$5,$6,$7,$8)", "pci:diag:" + Guid.NewGuid().ToString("N"), id,
                diagnostic.ContextId.Length == 0 ? null : diagnostic.ContextId, diagnostic.FilePath is null ? null : fileIds.GetValueOrDefault(diagnostic.FilePath),
                diagnostic.Code, diagnostic.Severity, diagnostic.Message, diagnostic.Range is null ? null : JsonSerializer.Serialize(diagnostic.Range), generation);
        connection.Execute(transaction, "UPDATE repositories SET structural_generation=$0,desired_revision=$0,query_epoch=query_epoch+1,state='ready',last_reconciled_utc=$1 WHERE repository_id=$2",
            generation, DateTimeOffset.UtcNow.ToString("O"), id);
        cancellationToken.ThrowIfCancellationRequested(); transaction.Commit();
        return new(id, generation, sources.Count, analysis.Symbols.Count, true);
    }

    private static IEnumerable<string> ReadContextHashes(SqliteConnection connection, SqliteTransaction transaction, string id)
    {
        using var command = connection.Command(transaction, "SELECT context_hash FROM contexts c JOIN projects p ON p.project_id=c.project_id WHERE p.repository_id=$0 ORDER BY context_id", id);
        using var reader = command.ExecuteReader(); while (reader.Read()) yield return reader.GetString(0);
    }
    private static void Clear(SqliteConnection connection, SqliteTransaction transaction, string id)
    {
        connection.Execute(transaction, "UPDATE embedding_sets SET state='stale' WHERE symbol_id IN(SELECT symbol_id FROM symbols WHERE repository_id=$0)", id);
        connection.Execute(transaction, "DELETE FROM symbols WHERE repository_id=$0", id);
        connection.Execute(transaction, "DELETE FROM projects WHERE repository_id=$0", id);
        connection.Execute(transaction, "DELETE FROM files WHERE repository_id=$0", id);
        connection.Execute(transaction, "DELETE FROM diagnostics WHERE repository_id=$0", id);
    }
    private static string SplitCamel(string text)
    {
        var output = new StringBuilder();
        for (var i = 0; i < text.Length; i++) { if (i > 0 && char.IsUpper(text[i]) && char.IsLower(text[i - 1])) output.Append(' '); output.Append(text[i]); }
        return output.ToString();
    }
}
