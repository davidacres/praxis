using System.Buffers.Binary;
using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Host;
using Praxis.CodeIntelligence.Indexing;
using System.Text.Json;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class HostTests
{
    [Fact]
    public async Task ClientRefreshesRejectedHandshakeBeforeDispatchingARequest()
    {
        var directory = Path.Combine(Path.GetTempPath(), "pci-" + Guid.NewGuid().ToString("N")[..8]);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var owner = OwnerService.RunAsync(directory, cancellation.Token);
        try
        {
            var rendezvous = Path.Combine(directory, "owner.json");
            var original = File.ReadAllText(rendezvous);
            var stale = JsonNode.Parse(original)!.AsObject(); stale["token"] = new string('0', 64);
            File.WriteAllText(rendezvous, stale.ToJsonString());
            var request = OwnerService.SendAsync(directory, new JsonObject { ["action"] = "list" }, cancellation.Token);
            await Task.Delay(200, cancellation.Token);
            Assert.False(request.IsCompleted, "A rejected handshake must refresh discovery rather than surface a stale-token error.");
            File.WriteAllText(rendezvous + ".tmp", original); File.Move(rendezvous + ".tmp", rendezvous, overwrite: true);
            var response = await request.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Null(response["error"]); Assert.Empty(response["data"]!.AsArray());
        }
        finally
        {
            cancellation.Cancel(); await owner;
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task ExplicitRebuildRepublishesUnchangedInputsAndPreservesManualAliases()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-rebuild-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var source = Path.Combine(root, "source"); Directory.CreateDirectory(source); File.WriteAllText(Path.Combine(source, "Example.cs"), "class Example {}");
            using var runtime = new ServiceRuntime(Path.Combine(root, "data")); var id = runtime.Indexer.Register(source);
            var original = runtime.Indexer.Index(id);
            using (var read = runtime.Database.Open(readOnly: true))
            using (var command = read.CreateCommand())
            {
                command.CommandText = "SELECT symbol_id FROM symbols WHERE name='Example'";
                runtime.Indexer.AddAlias(id, (string)command.ExecuteScalar()!, "special recovery concept");
            }
            var queued = runtime.Dispatch(new JsonObject { ["action"] = "rebuild", ["repositoryId"] = id }, CancellationToken.None);
            Assert.Null(queued["error"]); Assert.True(queued["data"]!["queued"]!.GetValue<bool>());
            await runtime.MaintainAsync(CancellationToken.None);
            Assert.Equal(original.Generation + 1, runtime.Indexer.Get(id).Generation);
            using var connection = runtime.Database.Open(readOnly: true); using var aliases = connection.CreateCommand();
            aliases.CommandText = "SELECT count(*) FROM aliases"; Assert.Equal(1L, aliases.ExecuteScalar());
            Assert.Empty(runtime.Database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task RelocationPreservesRepositoryIdentityAndExclusionsButRevokesOldFactsAndGrants()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-relocate-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var before = Path.Combine(root, "before"); var after = Path.Combine(root, "after"); Directory.CreateDirectory(before); Directory.CreateDirectory(after);
            File.WriteAllText(Path.Combine(before, "Before.cs"), "class Before {}"); File.WriteAllText(Path.Combine(after, "After.cs"), "class After {}");
            Directory.CreateDirectory(Path.Combine(after, "private")); File.WriteAllText(Path.Combine(after, "private", "Secret.cs"), "class Secret {}");
            File.WriteAllText(Path.Combine(before, "captured.praxis.json"), JsonSerializer.Serialize(new PassiveManifest(1, [new("app", "App", ["Before.cs"])])));
            using var runtime = new ServiceRuntime(Path.Combine(root, "data")); var id = runtime.Indexer.Register(before, new("captured.praxis.json", ["private"])); runtime.Indexer.Index(id);
            var grant = new JsonObject { ["action"] = "grant", ["repositoryId"] = id, ["client"] = "codex" };
            Assert.Null(runtime.Dispatch(grant, CancellationToken.None)["error"]);
            var relocated = runtime.Dispatch(new JsonObject { ["action"] = "relocate", ["repositoryId"] = id, ["root"] = after }, CancellationToken.None);
            Assert.Null(relocated["error"]); Assert.True(relocated["data"]!["grantsRevoked"]!.GetValue<bool>());
            var current = runtime.Indexer.Get(id); Assert.Equal(SourceFiles.CanonicalDirectory(after), current.Root);
            Assert.Null(current.Config.Manifest); Assert.Equal(new[] { "private" }, current.Config.Excludes);
            using (var read = runtime.Database.Open(readOnly: true))
            using (var command = read.CreateCommand())
            { command.CommandText = "SELECT count(*) FROM symbols"; Assert.Equal(0L, command.ExecuteScalar()); }
            var query = new JsonObject { ["action"] = "query", ["client"] = "codex", ["tool"] = "get_index_status", ["arguments"] = new JsonObject { ["repositoryId"] = id } };
            Assert.Equal("ACCESS_DENIED", runtime.Dispatch(query, CancellationToken.None)["error"]!["code"]!.GetValue<string>());
            await runtime.MaintainAsync(CancellationToken.None);
            using (var read = runtime.Database.Open(readOnly: true))
            using (var command = read.CreateCommand())
            { command.CommandText = "SELECT name FROM symbols WHERE kind='type'"; Assert.Equal("After", command.ExecuteScalar()); }
            Assert.Null(runtime.Dispatch(grant, CancellationToken.None)["error"]);
            Assert.Null(runtime.Dispatch(query, CancellationToken.None)["error"]);
            var duplicate = runtime.Indexer.Register(before);
            Assert.Throws<ArgumentException>(() => runtime.Indexer.Relocate(id, before));
            Assert.Equal(SourceFiles.CanonicalDirectory(after), runtime.Indexer.Get(id).Root); Assert.NotEqual(id, duplicate);
            Assert.Empty(runtime.Database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task RepositoryMonitorRebindsWhenTheRegisteredRootChanges()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-monitor-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var before = Path.Combine(root, "before"); var after = Path.Combine(root, "after"); Directory.CreateDirectory(before); Directory.CreateDirectory(after);
            using var monitor = new RepositoryMonitor();
            var repository = new RepositoryRecord("repo", before, 1, 1, "ready", new());
            monitor.Poll([repository]); await Task.Delay(700); Assert.Contains("repo", monitor.Poll([repository]));
            repository = repository with { Root = after };
            monitor.Poll([repository]); await Task.Delay(700); Assert.Contains("repo", monitor.Poll([repository]));
            File.WriteAllText(Path.Combine(after, "Changed.cs"), "class Changed {}");
            await Task.Delay(700); Assert.Contains("repo", monitor.Poll([repository]));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task FramingRoundTripsAndRejectsOversizeBeforeAllocation()
    {
        using var stream = new MemoryStream(); var value = new JsonObject { ["message"] = "Unicode 😀", ["number"] = 7 };
        await Framing.WriteAsync(stream, value, 1024, CancellationToken.None); stream.Position = 0;
        Assert.Equal(value.ToJsonString(), (await Framing.ReadAsync(stream, 1024, CancellationToken.None)).ToJsonString());
        var length = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(length, int.MaxValue);
        using var oversized = new MemoryStream(length); await Assert.ThrowsAsync<IOException>(() => Framing.ReadAsync(oversized, 1024, CancellationToken.None));
        using var incomplete = new MemoryStream(new byte[] { 4, 0, 0, 0, 123 }); await Assert.ThrowsAsync<EndOfStreamException>(() => Framing.ReadAsync(incomplete, 1024, CancellationToken.None));
    }

    [Fact]
    public void PersistedRepositoryClientGrantsAreExplicitAndRevocable()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-host-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var runtime = new ServiceRuntime(Path.Combine(root, "data")); var id = runtime.Indexer.Register(root);
            JsonObject Request(string action) => new() { ["action"] = action, ["repositoryId"] = id, ["client"] = "codex" };
            JsonObject Query(string client) => new() { ["action"] = "query", ["client"] = client, ["tool"] = "get_index_status", ["arguments"] = new JsonObject { ["repositoryId"] = id } };
            Assert.Equal("ACCESS_DENIED", runtime.Dispatch(Query("codex"), CancellationToken.None)["error"]!["code"]!.GetValue<string>());
            Assert.Null(runtime.Dispatch(Request("grant"), CancellationToken.None)["error"]);
            Assert.Null(new ServiceRuntime(Path.Combine(root, "data")).Dispatch(Query("codex"), CancellationToken.None)["error"]);
            Assert.Equal("ACCESS_DENIED", runtime.Dispatch(Query("claude"), CancellationToken.None)["error"]!["code"]!.GetValue<string>());
            runtime.Dispatch(Request("revoke"), CancellationToken.None);
            Assert.Equal("ACCESS_DENIED", runtime.Dispatch(Query("codex"), CancellationToken.None)["error"]!["code"]!.GetValue<string>());
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
