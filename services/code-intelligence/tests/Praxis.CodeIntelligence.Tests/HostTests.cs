using System.Buffers.Binary;
using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Host;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class HostTests
{
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
