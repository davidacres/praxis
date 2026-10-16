using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Praxis.CodeIntelligence.Host;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class DiskFullTests
{
    [Fact]
    public void DiskFullClassificationCoversSqliteAndPlatformFileErrors()
    {
        Assert.True(StorageFailures.IsDiskFull(new SqliteException("full", 13)));
        Assert.True(StorageFailures.IsDiskFull(new InvalidOperationException("wrapped", new SqliteException("full", 13))));
        Assert.False(StorageFailures.IsDiskFull(new SqliteException("busy", 5)));
        Assert.True(StorageFailures.IsDiskFull(OperatingSystem.IsWindows() ? new IOException("full", unchecked((int)0x80070070)) : new IOException("full", 28)));
        Assert.False(StorageFailures.IsDiskFull(new IOException("other")));
        Assert.False(StorageFailures.IsDiskFull(null));
    }

    [Fact]
    public async Task SqliteFullPausesWritesPreservesCommittedStateAndRecoversWhenSpaceReturns()
    {
        var root = Path.Combine(Path.GetTempPath(), "pci-disk-full-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var source = Path.Combine(root, "source"); Directory.CreateDirectory(source);
            File.WriteAllText(Path.Combine(source, "Example.cs"), "public class Example { public int Run() => 1; }");
            using var runtime = new ServiceRuntime(Path.Combine(root, "data")) { DiskFullRetryDelay = TimeSpan.Zero };
            var id = runtime.Indexer.Register(source); var original = runtime.Indexer.Index(id);
            JsonObject Search(string query) => runtime.Dispatch(new JsonObject { ["action"] = "query", ["tool"] = "search_code",
                ["arguments"] = new JsonObject { ["repositoryId"] = id, ["query"] = query, ["mode"] = "lexical" } }, CancellationToken.None);
            JsonObject Doctor() => runtime.Dispatch(new JsonObject { ["action"] = "doctor" }, CancellationToken.None);
            var before = Search("Example")["data"]!.ToJsonString();

            // A large edit cannot fit under the page cap, so publication fails
            // inside SQLite with SQLITE_FULL, as on a full volume.
            File.WriteAllText(Path.Combine(source, "Large.cs"), string.Join('\n', Enumerable.Range(0, 400).Select(i =>
                $"/// <summary>Grows the index {i}.</summary>\npublic class Large{i} {{ public int Value{i}() => {i}; }}")));
            using (var probe = runtime.Database.Open(readOnly: true)) using (var pages = probe.CreateCommand())
            { pages.CommandText = "PRAGMA page_count"; runtime.Database.WritablePageLimit = (long)pages.ExecuteScalar()! + 4; }

            var direct = runtime.Dispatch(new JsonObject { ["action"] = "index", ["repositoryId"] = id }, CancellationToken.None);
            Assert.Equal("DISK_FULL", direct["error"]!["code"]!.GetValue<string>());
            Assert.True(direct["error"]!["retryable"]!.GetValue<bool>());
            var paused = Doctor()["data"]!;
            Assert.True(paused["storage"]!["writesPaused"]!.GetValue<bool>());
            Assert.Equal("DISK_FULL", paused["storage"]!["code"]!.GetValue<string>());
            Assert.Empty(paused["checks"]!.AsArray());

            // Background work fails the same way without faulting maintenance.
            runtime.Dispatch(new JsonObject { ["action"] = "rebuild", ["repositoryId"] = id }, CancellationToken.None);
            await runtime.MaintainAsync(CancellationToken.None);
            await runtime.MaintainAsync(CancellationToken.None);
            Assert.Equal(original.Generation, runtime.Indexer.Get(id).Generation);
            Assert.Equal(before, Search("Example")["data"]!.ToJsonString());
            Assert.True(Doctor()["data"]!["storage"]!["writesPaused"]!.GetValue<bool>());
            Assert.Empty(runtime.Database.Check());

            // Space returns: the next maintenance pass reconciles and resumes.
            runtime.Database.WritablePageLimit = null;
            for (var pass = 0; pass < 4 && runtime.Indexer.Get(id).Generation == original.Generation; pass++)
                await runtime.MaintainAsync(CancellationToken.None);
            Assert.True(runtime.Indexer.Get(id).Generation > original.Generation);
            Assert.NotEmpty(Search("Large7")["data"]!["matches"]!.AsArray());
            Assert.False(Doctor()["data"]!["storage"]!["writesPaused"]!.GetValue<bool>());
            Assert.Empty(runtime.Database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
