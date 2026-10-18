using System.Buffers.Binary;
using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Host;
using Praxis.CodeIntelligence.Indexing;
using System.Text.Json;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class HostTests
{
    // The desktop shows, stops and restarts the owner, and replaces one running another build.
    // None of that may start an owner as a side effect: a status check that silently started
    // one would make "stopped" impossible to observe.
    [Fact]
    public async Task StatusAndStopNeverStartAnOwnerAndStopEndsTheRunningOne()
    {
        var directory = Path.Combine(Path.GetTempPath(), "pci-" + Guid.NewGuid().ToString("N")[..8]);
        var rendezvous = Path.Combine(directory, "owner.json");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try
        {
            Assert.False((await OwnerService.ProbeAsync(directory, cancellation.Token))["running"]!.GetValue<bool>());
            Assert.False((await OwnerService.StopAsync(directory, cancellation.Token))["stopped"]!.GetValue<bool>());
            Assert.False(File.Exists(rendezvous));

            var owner = OwnerService.RunAsync(directory, cancellation.Token);
            var status = await OwnerService.ProbeAsync(directory, cancellation.Token);
            Assert.True(status["running"]!.GetValue<bool>());
            Assert.Equal(Environment.ProcessId, status["processId"]!.GetValue<int>());
            Assert.Equal(OwnerService.Build, status["build"]!.GetValue<string>());
            Assert.True(DateTimeOffset.TryParse(status["startedUtc"]!.GetValue<string>(), out _));

            var stopped = await OwnerService.StopAsync(directory, cancellation.Token);
            Assert.True(stopped["stopped"]!.GetValue<bool>());
            await owner.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.False(File.Exists(rendezvous));
            Assert.False((await OwnerService.ProbeAsync(directory, cancellation.Token))["running"]!.GetValue<bool>());
        }
        finally { cancellation.Cancel(); Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task ClientRefreshesRejectedHandshakeBeforeDispatchingARequest()
    {
        var directory = Path.Combine(Path.GetTempPath(), "pci-" + Guid.NewGuid().ToString("N")[..8]);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(30));
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
            // Match the real startup/re-discovery budget. A three-second fixture
            // deadline flakes on loaded native runners despite a valid retry.
            var response = await request.WaitAsync(TimeSpan.FromSeconds(15));
            Assert.Null(response["error"]); Assert.Empty(response["data"]!.AsArray());
        }
        finally
        {
            cancellation.Cancel(); await owner;
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task EditsMadeWhileNoOwnerRanAreQueuedAtStartupAndPublished()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-startup-reconcile-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var source = Path.Combine(root, "source"); Directory.CreateDirectory(source); File.WriteAllText(Path.Combine(source, "Example.cs"), "class Example { int Run() => 1; }");
            string id; long generation;
            using (var first = new ServiceRuntime(Path.Combine(root, "data"))) { id = first.Indexer.Register(source); generation = first.Indexer.Index(id).Generation; }
            File.WriteAllText(Path.Combine(source, "Example.cs"), "class Example { int Run() => 2; int Added() => 3; }");
            using var restarted = new ServiceRuntime(Path.Combine(root, "data"));
            restarted.ScheduleStartupReconciliation();
            var status = restarted.Dispatch(new JsonObject { ["action"] = "query", ["tool"] = "get_index_status", ["arguments"] = new JsonObject { ["repositoryId"] = id } }, CancellationToken.None);
            Assert.Equal(1L, status["data"]!["jobsByState"]!["pending"]!.GetValue<long>());
            await restarted.MaintainAsync(CancellationToken.None);
            Assert.Equal(generation + 1, restarted.Indexer.Get(id).Generation);
            var found = restarted.Dispatch(new JsonObject { ["action"] = "query", ["tool"] = "find_symbol", ["arguments"] = new JsonObject { ["repositoryId"] = id, ["name"] = "Added" } }, CancellationToken.None);
            Assert.NotEmpty(found["data"]!["items"]!.AsArray());
        }
        finally { Directory.Delete(root, recursive: true); }
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
            using var runtime = new ServiceRuntime(Path.Combine(root, "data")); var id = runtime.Indexer.Register(root);
            JsonObject Request(string action) => new() { ["action"] = action, ["repositoryId"] = id, ["client"] = "codex" };
            JsonObject Query(string client) => new() { ["action"] = "query", ["client"] = client, ["tool"] = "get_index_status", ["arguments"] = new JsonObject { ["repositoryId"] = id } };
            Assert.Equal("ACCESS_DENIED", runtime.Dispatch(Query("codex"), CancellationToken.None)["error"]!["code"]!.GetValue<string>());
            Assert.Null(runtime.Dispatch(Request("grant"), CancellationToken.None)["error"]);
            using (var restarted = new ServiceRuntime(Path.Combine(root, "data"))) Assert.Null(restarted.Dispatch(Query("codex"), CancellationToken.None)["error"]);
            Assert.Equal("ACCESS_DENIED", runtime.Dispatch(Query("claude"), CancellationToken.None)["error"]!["code"]!.GetValue<string>());
            runtime.Dispatch(Request("revoke"), CancellationToken.None);
            Assert.Equal("ACCESS_DENIED", runtime.Dispatch(Query("codex"), CancellationToken.None)["error"]!["code"]!.GetValue<string>());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task AnIdleReconcileKeepsTheQueryEpochSoPagingCursorsSurvive()
    {
        // The monitor reconciles every repository each minute. Job bookkeeping alone must not
        // change the query epoch (spec: heartbeat/log-only changes do not increment it), or every
        // paging cursor expires within a minute on a repository nobody is editing.
        var root = Path.Combine(Path.GetTempPath(), "praxis-epoch-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            for (var i = 0; i < 6; i++) File.WriteAllText(Path.Combine(root, $"Widget{i}.cs"), $"class Widget{i} {{ void Render() {{}} }}");
            using var runtime = new ServiceRuntime(Path.Combine(root, "data")); var id = runtime.Indexer.Register(root); runtime.Indexer.Index(id);
            JsonObject Search(string? cursor)
            {
                var arguments = new JsonObject { ["repositoryId"] = id, ["query"] = "Render", ["mode"] = "lexical", ["limit"] = 2 };
                if (cursor is not null) arguments["cursor"] = cursor;
                return runtime.Dispatch(new JsonObject { ["action"] = "query", ["tool"] = "search_code", ["arguments"] = arguments }, CancellationToken.None);
            }
            var first = Search(null); var cursor = first["nextCursor"]!.GetValue<string>();
            runtime.Scheduler.Schedule(id, "index", "reconcile", "{}", runtime.Indexer.Get(id).Generation);
            await runtime.MaintainAsync(CancellationToken.None);
            var next = Search(cursor);
            Assert.Null(next["error"]);
            Assert.Equal(first["queryEpoch"]!.GetValue<long>(), next["queryEpoch"]!.GetValue<long>());
            Assert.NotEmpty(next["data"]!["matches"]!.AsArray());
            // A real change still invalidates the cursor.
            File.WriteAllText(Path.Combine(root, "Widget0.cs"), "class Widget0 { void Render() {} void Hide() {} }");
            runtime.Indexer.Index(id);
            Assert.Equal("CURSOR_EXPIRED", Search(cursor)["error"]!["code"]!.GetValue<string>());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public void OnlyReadsAndGrantFileChangesBypassTheWriter()
    {
        // Background index and vector jobs hold the writer for minutes; these must not queue behind them.
        foreach (var action in new[] { "query", "list", "grants", "grant", "revoke" }) Assert.True(OwnerService.RunsBesideWriter(action), action);
        foreach (var action in new[] { "register", "index", "rebuild", "relocate", "pause", "resume", "unregister", "alias", "model-install", "model-activate", "backup", "doctor", "enrichment-configure", null })
            Assert.False(OwnerService.RunsBesideWriter(action), action ?? "(none)");
    }

    [Fact]
    public void GrantListingShowsOnlyRepositoriesTheClientCanStillQuery()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-grant-list-tests-" + Guid.NewGuid().ToString("N"));
        var first = Path.Combine(root, "first"); var second = Path.Combine(root, "second"); var moved = Path.Combine(root, "moved");
        Directory.CreateDirectory(first); Directory.CreateDirectory(second); Directory.CreateDirectory(moved);
        try
        {
            using var runtime = new ServiceRuntime(Path.Combine(root, "data"));
            var firstId = runtime.Indexer.Register(first); var secondId = runtime.Indexer.Register(second);
            string[] Listed(string client) => runtime.Dispatch(new JsonObject { ["action"] = "grants", ["client"] = client }, CancellationToken.None)["data"]!
                .AsArray().Select(entry => entry!["repositoryId"]!.GetValue<string>()).Order(StringComparer.Ordinal).ToArray();
            void Grant(string id, string client) => Assert.Null(runtime.Dispatch(new JsonObject { ["action"] = "grant", ["repositoryId"] = id, ["client"] = client }, CancellationToken.None)["error"]);
            Assert.Empty(Listed("claude-cli"));
            Grant(firstId, "claude-cli"); Grant(secondId, "claude-cli"); Grant(secondId, "codex");
            Assert.Equal(new[] { firstId, secondId }.Order(StringComparer.Ordinal), Listed("claude-cli"));
            Assert.Equal(new[] { secondId }, Listed("codex"));
            var entry = runtime.Dispatch(new JsonObject { ["action"] = "grants", ["client"] = "codex" }, CancellationToken.None)["data"]![0]!;
            Assert.Equal(SourceFiles.CanonicalDirectory(second), entry["root"]!.GetValue<string>());
            runtime.Dispatch(new JsonObject { ["action"] = "revoke", ["repositoryId"] = firstId, ["client"] = "claude-cli" }, CancellationToken.None);
            Assert.Equal(new[] { secondId }, Listed("claude-cli"));
            // Relocation revokes, so a moved repository drops out until it is granted again.
            Assert.Null(runtime.Dispatch(new JsonObject { ["action"] = "relocate", ["repositoryId"] = secondId, ["root"] = moved }, CancellationToken.None)["error"]);
            Assert.Empty(Listed("claude-cli")); Assert.Empty(Listed("codex"));
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
