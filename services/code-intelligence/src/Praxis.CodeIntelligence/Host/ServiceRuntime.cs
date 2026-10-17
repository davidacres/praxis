using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;
using Praxis.CodeIntelligence.Embeddings;
using Praxis.CodeIntelligence.Enrichment;
using System.Text.Json;
using System.Collections.Concurrent;

namespace Praxis.CodeIntelligence.Host;

public sealed class ServiceRuntime : IDisposable
{
    public IndexDatabase Database { get; }
    public RepositoryIndexer Indexer { get; }
    public EnrichmentService Enrichment { get; } = new();
    private readonly QueryService queries;
    private readonly ModelStore models;
    public DurableScheduler Scheduler { get; }
    private readonly RepositoryMonitor monitor = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> activeJobs = new(StringComparer.Ordinal);
    private readonly string grantsDirectory, dataDirectory;
    // Held open for the owner's lifetime so SQLite keeps its -wal/-shm files.
    // Without it the last close removes them, and on a full volume no later
    // connection (reads included) can recreate them.
    private readonly Microsoft.Data.Sqlite.SqliteConnection keepAlive;
    // SQLite has already rolled the failed transaction back; pausing keeps the
    // maintenance loop alive without hammering a full volume.
    private readonly object storageLock = new();
    private DateTimeOffset? diskFullUtc; private DateTimeOffset writesResumeUtc = DateTimeOffset.MinValue;
    internal TimeSpan DiskFullRetryDelay { get; init; } = TimeSpan.FromSeconds(30);
    internal TimeProvider Clock { get; init; } = TimeProvider.System;
    public ServiceRuntime(string dataDirectory)
    {
        Directory.CreateDirectory(dataDirectory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(dataDirectory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        this.dataDirectory = dataDirectory;
        Database = new(Path.Combine(dataDirectory, "index.db")); Database.Initialize(); keepAlive = Database.Open(); Indexer = new(Database);
        models = new(Database, Path.Combine(dataDirectory, "models")); queries = new(Database, models, Enrichment);
        Scheduler = new(Database);
        grantsDirectory = Path.Combine(dataDirectory, "grants"); Directory.CreateDirectory(grantsDirectory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(grantsDirectory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }
    public JsonObject Dispatch(JsonObject request, CancellationToken cancellationToken)
    {
        try
        {
            var action = request["action"]?.GetValue<string>() ?? throw new ArgumentException("Action is required.");
            var repositoryId = request["repositoryId"]?.GetValue<string>();
            switch (action)
            {
                case "list": return Result(Indexer.List());
                case "register":
                {
                    var registered = Indexer.Register(request["root"]!.GetValue<string>(),
                        new(request["manifest"]?.GetValue<string>(), request["excludes"]?.AsArray().Select(x => x!.GetValue<string>()).ToArray()));
                    if (Indexer.Get(registered).State != "paused") ScheduleIndex(registered);
                    return Result(new { repositoryId = registered });
                }
                case "index": return Result(Indexer.Index(repositoryId!, cancellationToken));
                case "rebuild":
                {
                    var repository = Indexer.Get(repositoryId!);
                    if (repository.State == "paused") throw new InvalidOperationException("Repository is paused.");
                    CancelRepositoryWork(repositoryId!); Scheduler.CancelRepository(repositoryId!);
                    Scheduler.Schedule(repositoryId!, "index", "rebuild", "{\"force\":true}", repository.Generation);
                    return Result(new { queued = true });
                }
                case "relocate":
                {
                    var root = SourceFiles.CanonicalDirectory(request["root"]!.GetValue<string>());
                    CancelRepositoryWork(repositoryId!); Scheduler.CancelRepository(repositoryId!);
                    RevokeRepositoryGrants(repositoryId!);
                    Indexer.Relocate(repositoryId!, root, request["manifest"]?.GetValue<string>());
                    if (Indexer.Get(repositoryId!).State != "paused") ScheduleIndex(repositoryId!);
                    return Result(new { repositoryId, relocated = true, grantsRevoked = true });
                }
                case "alias": Indexer.AddAlias(repositoryId!, request["symbolId"]!.GetValue<string>(), request["phrase"]!.GetValue<string>()); return Result(new { added = true });
                case "pause": CancelRepositoryWork(repositoryId!); Scheduler.CancelRepository(repositoryId!); Indexer.SetPaused(repositoryId!, true); return Result(new { paused = true });
                case "resume": Indexer.SetPaused(repositoryId!, false); return Result(Indexer.Index(repositoryId!, cancellationToken));
                case "unregister":
                    CancelRepositoryWork(repositoryId!); Scheduler.CancelRepository(repositoryId!);
                    RevokeRepositoryGrants(repositoryId!);
                    Indexer.Unregister(repositoryId!); return Result(new { unregistered = true });
                case "grant":
                    Indexer.Get(repositoryId!); SaveGrant(repositoryId!, Client(request)); return Result(new { granted = true });
                case "revoke": File.Delete(GrantPath(repositoryId!, Client(request))); return Result(new { revoked = true });
                case "grants":
                {
                    // Only grants that still pass the query-time check (same root, nonce present) are listed.
                    var client = Client(request);
                    return Result(Indexer.List().Where(repository => GrantSnapshot(repository.Id, client) is not null)
                        .Select(repository => new { repositoryId = repository.Id, root = repository.Root, state = repository.State }).ToArray());
                }
                case "query":
                {
                    var arguments = request["arguments"]!.AsObject(); var id = arguments["repositoryId"]?.GetValue<string>() ?? "unknown";
                    var client = request["client"] is null ? null : Client(request);
                    var grant = client is null ? null : GrantSnapshot(id, client);
                    var allowed = client is null || grant is not null;
                    var result = queries.Execute(request["tool"]!.GetValue<string>(), arguments, allowed ? new HashSet<string> { id } : new HashSet<string>(), cancellationToken);
                    // Consent may change while inference/source reads run. Never return data
                    // authorized by an earlier root or by a revoked/reissued grant.
                    if (client is not null && (grant is null || grant != GrantSnapshot(id, client)))
                        return queries.Execute(request["tool"]!.GetValue<string>(), arguments, new HashSet<string>(), cancellationToken);
                    return result;
                }
                case "doctor": return Result(new { checks = Database.Check(), storage = StorageStatus(), memory = MemoryPressure.Status() });
                case "model-install": return Result(new { fingerprint = models.Install(request["bundle"]!.GetValue<string>()) });
                case "model-activate": QueueModel(repositoryId!, request["fingerprint"]!.GetValue<string>()); return Result(new { queued = true });
                case "backup": Database.Backup(request["destination"]!.GetValue<string>()); return Result(new { backedUp = true });
                case "enrichment-configure":
                {
                    var enabled = request["enabled"]?.GetValue<bool>() ?? false;
                    var endpoint = request["endpoint"]?.GetValue<string>();
                    var model = request["model"]?.GetValue<string>() ?? "default";
                    if (enabled && endpoint is not null)
                    {
                        var uri = new Uri(endpoint);
                        LoopbackSecurity.ValidateLoopbackUri(uri);
                        var client = new LocalLlmClient(uri, model);
                        Enrichment.Configure(client);
                    }
                    else
                    {
                        Enrichment.Configure(null);
                    }
                    return Result(new { enabled = Enrichment.IsEnabled, model = Enrichment.Client?.Model });
                }
                default: throw new ArgumentException("Unknown action.");
            }
        }
        catch (OperationCanceledException) { return Error("CANCELLED", "Operation cancelled."); }
        catch (Exception ex) when (DiskFull(ex))
        {
            PauseWrites();
            return Error("DISK_FULL", "The index volume is full. The last committed index is unchanged; background writes are paused until space is available.", retryable: true);
        }
        catch (KeyNotFoundException) { return Error("REPOSITORY_NOT_FOUND", "Repository is not registered."); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or System.Text.Json.JsonException)
        { return Error("OPERATION_FAILED", "Operation could not complete; check source access, passive context and owner state."); }
        catch (Microsoft.Data.Sqlite.SqliteException)
        { return Error("OPERATION_FAILED", "The index database could not complete the operation; run doctor for integrity checks.", retryable: true); }
    }
    private bool DiskFull(Exception error) => StorageFailures.IsDiskFull(error, dataDirectory);
    private void RevokeRepositoryGrants(string repositoryId)
    {
        foreach (var path in Directory.EnumerateFiles(grantsDirectory))
        {
            var grant = JsonNode.Parse(File.ReadAllText(path));
            if (grant?["repositoryId"]?.GetValue<string>() == repositoryId) File.Delete(path);
        }
    }
    private static string Client(JsonObject request)
    {
        var client = request["client"]!.GetValue<string>();
        if (client.Length is < 1 or > 256) throw new ArgumentException("Client scope is invalid."); return client;
    }
    private string GrantPath(string id, string client) => Path.Combine(grantsDirectory, Identity.Id("", id, client) + ".json");
    private string? GrantSnapshot(string id, string client)
    {
        try
        {
            var path = GrantPath(id, client); if (!File.Exists(path)) return null;
            var text = File.ReadAllText(path); var grant = JsonNode.Parse(text);
            return grant?["repositoryId"]?.GetValue<string>() == id && grant?["client"]?.GetValue<string>() == client
                && grant?["root"]?.GetValue<string>() == Indexer.Get(id).Root && grant?["nonce"]?.GetValue<string>() is { Length: > 0 } ? text : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or KeyNotFoundException or System.Text.Json.JsonException)
        { return null; }
    }
    private void SaveGrant(string id, string client)
    {
        var path = GrantPath(id, client); var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, new JsonObject { ["repositoryId"] = id, ["client"] = client, ["root"] = Indexer.Get(id).Root, ["nonce"] = Guid.NewGuid().ToString("N") }.ToJsonString());
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temporary, path, overwrite: true);
        }
        finally { File.Delete(temporary); }
    }
    public static JsonObject Result<T>(T data) => new() { ["data"] = System.Text.Json.JsonSerializer.SerializeToNode(data, new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase }) };
    public static JsonObject Error(string code, string message, bool retryable = false) => new() { ["error"] = new JsonObject { ["code"] = code, ["message"] = message, ["retryable"] = retryable } };
    private void PauseWrites(bool diskFull = true)
    {
        lock (storageLock) { var now = Clock.GetUtcNow(); if (diskFull) diskFullUtc ??= now; writesResumeUtc = now + DiskFullRetryDelay; }
    }
    private object StorageStatus()
    {
        lock (storageLock)
            return new { writesPaused = diskFullUtc is not null, code = diskFullUtc is null ? null : "DISK_FULL",
                sinceUtc = diskFullUtc?.ToString("O"), retryUtc = diskFullUtc is null ? null : writesResumeUtc.ToString("O") };
    }
    private void ScheduleIndex(string repositoryId)
    {
        var repository = Indexer.Get(repositoryId);
        Scheduler.Schedule(repositoryId, "index", "reconcile", "{}", repository.Generation);
    }
    private void QueueModel(string repositoryId, string fingerprint)
    {
        var repository = Indexer.Get(repositoryId);
        if (repository.State != "ready") throw new InvalidOperationException("Index must be ready before activating a model.");
        using var connection = Database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        if (connection.Scalar(transaction, "SELECT fingerprint FROM model_profiles WHERE fingerprint=$0", fingerprint) is null) throw new ArgumentException("Model is not installed.");
        connection.Execute(transaction, "UPDATE jobs SET state='obsolete',lease_token=NULL,lease_owner=NULL,lease_until_utc=NULL WHERE repository_id=$0 AND kind='embed' AND state IN('pending','leased')", repositoryId);
        connection.Execute(transaction, "UPDATE repository_models SET state='failed' WHERE repository_id=$0 AND state='building' AND model_fingerprint!=$1", repositoryId, fingerprint);
        connection.Execute(transaction, "INSERT INTO repository_models VALUES($0,$1,'building',NULL) ON CONFLICT(repository_id,model_fingerprint) DO UPDATE SET state=CASE WHEN repository_models.state='active' THEN 'active' ELSE 'building' END", repositoryId, fingerprint);
        var key = Identity.Id("", fingerprint, repository.Generation);
        connection.Execute(transaction, "INSERT INTO jobs(job_id,repository_id,kind,input_key,payload_json,desired_revision,state,available_utc) VALUES($0,$1,'embed',$2,$3,$4,'pending',$5) ON CONFLICT(repository_id,kind,input_key) DO UPDATE SET state='pending',attempts=0,lease_token=NULL,lease_owner=NULL,lease_until_utc=NULL,available_utc=excluded.available_utc,error_code=NULL,error_message=NULL",
            Identity.Id("pci:job:", repositoryId, "embed", key), repositoryId, key, JsonSerializer.Serialize(new { fingerprint }), repository.Generation, DateTimeOffset.UtcNow.ToString("O"));
        connection.Execute(transaction, "UPDATE repositories SET query_epoch=query_epoch+1 WHERE repository_id=$0", repositoryId); transaction.Commit();
    }
    /// <summary>
    /// Sources may have changed while no owner was watching. Queue reconciliation
    /// before accepting clients so status never reports such an index as settled.
    /// </summary>
    public void ScheduleStartupReconciliation()
    {
        foreach (var repository in Indexer.List())
            if (repository.State != "paused")
                try { ScheduleIndex(repository.Id); }
                catch (Exception ex) when (DiskFull(ex)) { PauseWrites(); }
    }
    public void CancelRepositoryWork(string repositoryId)
    {
        if (activeJobs.TryGetValue(repositoryId, out var cancellation))
            try { cancellation.Cancel(); } catch (ObjectDisposedException) { }
    }

    public async Task MaintainAsync(CancellationToken cancellationToken)
    {
        bool resuming;
        lock (storageLock)
        {
            if (Clock.GetUtcNow() < writesResumeUtc) return;
            resuming = diskFullUtc is not null;
        }
        try
        {
            // A job that failed on a full volume may have exhausted its retries;
            // reconcile everything once writes resume so no index stays stale.
            if (resuming) foreach (var repository in Indexer.List()) if (repository.State != "paused") ScheduleIndex(repository.Id);
            foreach (var repositoryId in monitor.Poll(Indexer.List())) ScheduleIndex(repositoryId);
            await RunNextJobAsync(cancellationToken);
            if (resuming) lock (storageLock) if (Clock.GetUtcNow() >= writesResumeUtc) diskFullUtc = null;
        }
        catch (Exception ex) when (DiskFull(ex)) { PauseWrites(); }
        // Any other storage failure backs off rather than ending the maintenance loop.
        catch (Exception ex) when (ex is Microsoft.Data.Sqlite.SqliteException or IOException) { PauseWrites(diskFull: false); }
    }

    private async Task RunNextJobAsync(CancellationToken cancellationToken)
    {
        // §31.3: at the memory soft limit, do not start background inference.
        var job = Scheduler.LeaseNext(includeEmbedding: !MemoryPressure.Active); if (job is null) return;
        using var work = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); activeJobs[job.RepositoryId] = work;
        using var heartbeatCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var heartbeat = Task.Run(async () =>
        {
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(20));
            while (await timer.WaitForNextTickAsync(heartbeatCancellation.Token))
                if (!Scheduler.Heartbeat(job)) { work.Cancel(); break; }
        }, heartbeatCancellation.Token);
        try
        {
            if (job.Kind == "index") await Task.Run(() => Indexer.Index(job.RepositoryId, work.Token, job.Token, JsonNode.Parse(job.Payload)?["force"]?.GetValue<bool>() == true), work.Token);
            else
            {
                var repository = Indexer.Get(job.RepositoryId);
                if (repository.Generation != job.DesiredRevision || repository.State != "ready") { Scheduler.Obsolete(job); return; }
                var fingerprint = JsonNode.Parse(job.Payload)!["fingerprint"]!.GetValue<string>();
                await Task.Run(() => models.Activate(job.RepositoryId, fingerprint, work.Token, job.Token), work.Token);
            }
            Scheduler.Complete(job);
        }
        catch (OperationCanceledException) { Scheduler.Fail(job, "CANCELLED"); }
        catch (Exception ex) when (DiskFull(ex))
        {
            PauseWrites();
            // Recording the failure is itself a write; if it cannot commit, the
            // lease expires and normal recovery reclaims the job.
            try { Scheduler.Fail(job, "DISK_FULL"); } catch (Exception recording) when (DiskFull(recording)) { }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException or JsonException or Microsoft.ML.OnnxRuntime.OnnxRuntimeException or Microsoft.Data.Sqlite.SqliteException)
        { Scheduler.Fail(job, ex is InvalidOperationException ? "INDEX_STALE" : "OPERATION_FAILED"); }
        finally
        {
            heartbeatCancellation.Cancel(); try { await heartbeat; } catch (OperationCanceledException) { }
            activeJobs.TryRemove(job.RepositoryId, out _);
        }
    }
    public void Dispose() { foreach (var work in activeJobs.Values) work.Cancel(); monitor.Dispose(); models.Dispose(); keepAlive.Dispose(); }
}
