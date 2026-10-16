using Microsoft.Data.Sqlite;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;

namespace Praxis.CodeIntelligence.Host;

public sealed record LeasedJob(string Id, string RepositoryId, string Kind, string Payload, long DesiredRevision, string Token, int Attempts);

/// <summary>Persistent, coalesced jobs. Publication and state transitions require the current unexpired lease.</summary>
public sealed class DurableScheduler(IndexDatabase database, TimeProvider? timeProvider = null)
{
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private readonly string owner = Guid.NewGuid().ToString("N");
    private static readonly int[] RetrySeconds = [1, 5, 30, 120, 300];
    private string Now => clock.GetUtcNow().ToString("O");

    public string Schedule(string repositoryId, string kind, string inputKey, string payload, long desiredRevision)
    {
        if (kind is not ("index" or "embed")) throw new ArgumentException("Unsupported job kind.");
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        if (connection.Scalar(transaction, "SELECT state FROM repositories WHERE repository_id=$0", repositoryId) as string is not string state)
            throw new KeyNotFoundException("REPOSITORY_NOT_FOUND");
        if (state == "paused") throw new InvalidOperationException("INDEX_BUSY: repository is paused.");
        var id = Identity.Id("pci:job:", repositoryId, kind, inputKey);
        var existing = connection.Scalar(transaction, "SELECT state FROM jobs WHERE job_id=$0", id) as string;
        // Pending retries retain their backoff; an active lease is never replaced by duplicate observations.
        if (existing is "pending" or "leased") { transaction.Commit(); return id; }
        connection.Execute(transaction,
            "INSERT INTO jobs(job_id,repository_id,kind,input_key,payload_json,desired_revision,state,available_utc) VALUES($0,$1,$2,$3,$4,$5,'pending',$6) "
            + "ON CONFLICT(job_id) DO UPDATE SET payload_json=excluded.payload_json,desired_revision=excluded.desired_revision,state='pending',attempts=0,available_utc=excluded.available_utc,lease_token=NULL,lease_owner=NULL,lease_until_utc=NULL,error_code=NULL,error_message=NULL",
            id, repositoryId, kind, inputKey, payload, desiredRevision, Now);
        connection.Execute(transaction, "UPDATE repositories SET query_epoch=query_epoch+1 WHERE repository_id=$0", repositoryId);
        transaction.Commit(); return id;
    }

    // includeEmbedding=false leaves embedding jobs pending (memory pressure).
    public LeasedJob? LeaseNext(bool includeEmbedding = true)
    {
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        RecoverExpired(connection, transaction);
        LeasedJob? job;
        using (var command = connection.Command(transaction,
            "SELECT j.job_id,j.repository_id,j.kind,j.payload_json,j.desired_revision,j.attempts FROM jobs j JOIN repositories r ON r.repository_id=j.repository_id "
            + "WHERE j.state='pending' AND j.available_utc<=$0 AND r.state!='paused' AND ($1 OR j.kind!='embed') ORDER BY CASE j.kind WHEN 'index' THEN 0 ELSE 1 END,j.available_utc,j.job_id LIMIT 1", Now, includeEmbedding))
        using (var reader = command.ExecuteReader())
            job = reader.Read() ? new(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetInt64(4), Guid.NewGuid().ToString("N"), reader.GetInt32(5) + 1) : null;
        if (job is not null)
        {
            connection.Execute(transaction, "UPDATE jobs SET state='leased',attempts=attempts+1,lease_token=$0,lease_owner=$1,lease_until_utc=$2 WHERE job_id=$3 AND state='pending'",
                job.Token, owner, clock.GetUtcNow().AddSeconds(60).ToString("O"), job.Id);
            connection.Execute(transaction, "UPDATE repositories SET query_epoch=query_epoch+1 WHERE repository_id=$0", job.RepositoryId);
        }
        transaction.Commit(); return job;
    }

    public bool Heartbeat(LeasedJob job)
    {
        using var connection = database.Open();
        return connection.Execute(null, "UPDATE jobs SET lease_until_utc=$0 WHERE job_id=$1 AND state='leased' AND lease_token=$2 AND lease_owner=$3 AND lease_until_utc>$4",
            clock.GetUtcNow().AddSeconds(60).ToString("O"), job.Id, job.Token, owner, Now) == 1;
    }

    public bool Complete(LeasedJob job) => Finish(job, null, obsolete: false);
    public bool Fail(LeasedJob job, string errorCode) => Finish(job, errorCode, obsolete: false);
    public bool Obsolete(LeasedJob job) => Finish(job, null, obsolete: true);

    private bool Finish(LeasedJob job, string? errorCode, bool obsolete)
    {
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        // A full volume is not the job's failure: the runtime pauses writes, so
        // the job returns to pending without using an attempt or a backoff slot.
        var diskFull = errorCode == "DISK_FULL";
        var retry = errorCode is not null && (diskFull || job.Attempts <= RetrySeconds.Length);
        var state = obsolete ? "obsolete" : errorCode is null ? "succeeded" : retry ? "pending" : "failed";
        var available = retry && !diskFull ? clock.GetUtcNow().AddSeconds(RetrySeconds[job.Attempts - 1]).ToString("O") : Now;
        var changed = connection.Execute(transaction,
            "UPDATE jobs SET state=$0,available_utc=$1,error_code=$2,error_message=$3,lease_token=NULL,lease_owner=NULL,lease_until_utc=NULL,attempts=attempts-$8 "
            + "WHERE job_id=$4 AND state='leased' AND lease_token=$5 AND lease_owner=$6 AND lease_until_utc>$7",
            state, available, errorCode, errorCode is null ? null : diskFull ? "The index volume is full; the job resumes when space is available." : "Background operation failed; retry or inspect repository status.", job.Id, job.Token, owner, Now, diskFull ? 1 : 0) == 1;
        if (changed) connection.Execute(transaction, "UPDATE repositories SET query_epoch=query_epoch+1 WHERE repository_id=$0", job.RepositoryId);
        transaction.Commit(); return changed;
    }

    public void CancelRepository(string repositoryId)
    {
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        var changed = connection.Execute(transaction, "UPDATE jobs SET state='obsolete',lease_token=NULL,lease_owner=NULL,lease_until_utc=NULL WHERE repository_id=$0 AND state IN('pending','leased')", repositoryId);
        if (changed > 0) connection.Execute(transaction, "UPDATE repositories SET query_epoch=query_epoch+1 WHERE repository_id=$0", repositoryId);
        transaction.Commit();
    }

    /// <summary>
    /// Call only while holding the exclusive owner lock: any job still leased by
    /// another owner then belongs to an owner that exited, so it is reclaimed now
    /// rather than after its lease expires (§31.2). Attempts are kept, so a job
    /// that keeps killing its owner still reaches the retry limit.
    /// </summary>
    public int ReclaimAbandonedLeases()
    {
        using var connection = database.Open(); using var transaction = connection.BeginTransaction(deferred: false);
        var repositories = new List<string>();
        using (var command = connection.Command(transaction, "SELECT DISTINCT repository_id FROM jobs WHERE state='leased' AND lease_owner!=$0", owner))
        using (var reader = command.ExecuteReader()) while (reader.Read()) repositories.Add(reader.GetString(0));
        var reclaimed = connection.Execute(transaction, "UPDATE jobs SET state=CASE WHEN attempts>=6 THEN 'failed' ELSE 'pending' END,error_code='OWNER_EXITED',error_message='Previous owner exited during this job.',lease_token=NULL,lease_owner=NULL,lease_until_utc=NULL,available_utc=$0 WHERE state='leased' AND lease_owner!=$1", Now, owner);
        foreach (var repository in repositories) connection.Execute(transaction, "UPDATE repositories SET query_epoch=query_epoch+1 WHERE repository_id=$0", repository);
        transaction.Commit(); return reclaimed;
    }

    private void RecoverExpired(SqliteConnection connection, SqliteTransaction transaction)
    {
        var repositories = new List<string>();
        using (var command = connection.Command(transaction, "SELECT DISTINCT repository_id FROM jobs WHERE state='leased' AND lease_until_utc<=$0", Now))
        using (var reader = command.ExecuteReader()) while (reader.Read()) repositories.Add(reader.GetString(0));
        connection.Execute(transaction, "UPDATE jobs SET state=CASE WHEN attempts>=6 THEN 'failed' ELSE 'pending' END,error_code='TIMEOUT',error_message='Previous worker lease expired.',lease_token=NULL,lease_owner=NULL,lease_until_utc=NULL,available_utc=$0 WHERE state='leased' AND lease_until_utc<=$0", Now);
        foreach (var repository in repositories) connection.Execute(transaction, "UPDATE repositories SET query_epoch=query_epoch+1 WHERE repository_id=$0", repository);
    }

    public static void AssertLease(SqliteConnection connection, SqliteTransaction transaction, string token)
    {
        var valid = connection.Scalar(transaction, "SELECT lease_token FROM jobs WHERE state='leased' AND lease_token=$0 AND lease_until_utc>$1", token, DateTimeOffset.UtcNow.ToString("O"));
        if (valid is null) throw new InvalidOperationException("INDEX_STALE: job lease expired or was replaced.");
    }
}
