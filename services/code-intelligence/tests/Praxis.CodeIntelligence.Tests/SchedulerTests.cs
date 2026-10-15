using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Host;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class SchedulerTests : IDisposable
{
    private sealed class Clock : TimeProvider
    {
        private DateTimeOffset now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(int seconds) => now = now.AddSeconds(seconds);
    }
    private readonly string root = Path.Combine(Path.GetTempPath(), "praxis-scheduler-tests-" + Guid.NewGuid().ToString("N"));
    private readonly IndexDatabase database;
    private readonly RepositoryIndexer indexer;
    private readonly string repository;
    private readonly Clock clock = new();
    public SchedulerTests()
    {
        Directory.CreateDirectory(root); database = new(Path.Combine(root, "data", "index.db")); database.Initialize(); indexer = new(database);
        File.WriteAllText(Path.Combine(root, "Example.cs"), "class Example {}"); repository = indexer.Register(root);
    }

    [Fact]
    public void DuplicatePendingWorkCoalescesAndRetryBackoffCannotBeBypassed()
    {
        var scheduler = new DurableScheduler(database, clock);
        var id = scheduler.Schedule(repository, "index", "reconcile", "{}", 0);
        Assert.Equal(id, scheduler.Schedule(repository, "index", "reconcile", "{}", 0));
        var job = Assert.IsType<LeasedJob>(scheduler.LeaseNext()); Assert.Equal(1, job.Attempts); Assert.Null(scheduler.LeaseNext());
        Assert.True(scheduler.Fail(job, "ROOT_UNAVAILABLE"));
        scheduler.Schedule(repository, "index", "reconcile", "{}", 0); Assert.Null(scheduler.LeaseNext());
        clock.Advance(1); var retry = Assert.IsType<LeasedJob>(scheduler.LeaseNext()); Assert.Equal(2, retry.Attempts); Assert.True(scheduler.Complete(retry));
    }

    [Fact]
    public void ExpiredLeaseIsRecoveredAndOldWorkerCannotCompleteHeartbeatOrPublish()
    {
        var firstOwner = new DurableScheduler(database, clock); firstOwner.Schedule(repository, "index", "reconcile", "{}", 0);
        var old = Assert.IsType<LeasedJob>(firstOwner.LeaseNext()); clock.Advance(61);
        Assert.False(firstOwner.Heartbeat(old)); Assert.False(firstOwner.Complete(old));
        var replacementOwner = new DurableScheduler(database, clock); var replacement = Assert.IsType<LeasedJob>(replacementOwner.LeaseNext());
        Assert.NotEqual(old.Token, replacement.Token); Assert.Equal(2, replacement.Attempts);
        Assert.Throws<InvalidOperationException>(() => indexer.Index(repository, leaseToken: old.Token));
        Assert.Equal(0, indexer.Get(repository).Generation); Assert.False(firstOwner.Complete(old));
        Assert.True(replacementOwner.Complete(replacement));
    }

    [Fact]
    public void HeartbeatExtendsLeaseAndPauseObsoletesAllWork()
    {
        var scheduler = new DurableScheduler(database, clock); scheduler.Schedule(repository, "index", "reconcile", "{}", 0);
        var job = Assert.IsType<LeasedJob>(scheduler.LeaseNext()); clock.Advance(50); Assert.True(scheduler.Heartbeat(job)); clock.Advance(20);
        Assert.Null(new DurableScheduler(database, clock).LeaseNext());
        scheduler.CancelRepository(repository); indexer.SetPaused(repository, true);
        Assert.False(scheduler.Complete(job)); Assert.Null(scheduler.LeaseNext());
        Assert.Throws<InvalidOperationException>(() => scheduler.Schedule(repository, "index", "reconcile", "{}", 0));
        Assert.Throws<InvalidOperationException>(() => indexer.Index(repository, leaseToken: job.Token));
    }

    [Fact]
    public void StructuralPublicationAtomicallyQueuesCurrentProfileRefresh()
    {
        indexer.Index(repository);
        var profile = "sha256:" + new string('a', 64);
        using (var connection = database.Open())
        {
            using var command = connection.CreateCommand();
            command.CommandText = "INSERT INTO model_profiles VALUES($profile,'{}',384,'cosine',1); INSERT INTO repository_models VALUES($repository,$profile,'active',NULL);";
            command.Parameters.AddWithValue("$profile", profile); command.Parameters.AddWithValue("$repository", repository); command.ExecuteNonQuery();
        }
        File.AppendAllText(Path.Combine(root, "Example.cs"), " // changed"); var changed = indexer.Index(repository);
        var scheduler = new DurableScheduler(database); var job = Assert.IsType<LeasedJob>(scheduler.LeaseNext());
        Assert.Equal("embed", job.Kind); Assert.Equal(changed.Generation, job.DesiredRevision); Assert.Equal(profile, JsonNode.Parse(job.Payload)!["fingerprint"]!.GetValue<string>());
        File.AppendAllText(Path.Combine(root, "Example.cs"), " // next edit"); indexer.Index(repository);
        Assert.False(scheduler.Complete(job));
        var next = Assert.IsType<LeasedJob>(scheduler.LeaseNext()); Assert.NotEqual(next.Id, job.Id); Assert.Equal(3, next.DesiredRevision);
    }

    [Fact]
    public async Task RuntimeDrainsDurableReconciliationWithoutChangingNoOpGeneration()
    {
        using var runtime = new ServiceRuntime(Path.Combine(root, "runtime"));
        var response = runtime.Dispatch(new JsonObject { ["action"] = "register", ["root"] = root }, CancellationToken.None);
        var id = response["data"]!["repositoryId"]!.GetValue<string>();
        await runtime.MaintainAsync(CancellationToken.None); var generation = runtime.Indexer.Get(id).Generation; Assert.Equal(1, generation);
        runtime.Scheduler.Schedule(id, "index", "reconcile", "{}", generation); await runtime.MaintainAsync(CancellationToken.None);
        Assert.Equal(generation, runtime.Indexer.Get(id).Generation);
        var status = runtime.Dispatch(new JsonObject { ["action"] = "query", ["tool"] = "get_index_status", ["arguments"] = new JsonObject { ["repositoryId"] = id } }, CancellationToken.None);
        Assert.Equal(1, status["data"]!["jobsByState"]!["succeeded"]!.GetValue<long>());
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}
