using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Host;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

// The pressure signal is process-wide, so these tests never run alongside others.
[CollectionDefinition(nameof(MemoryPressureTests), DisableParallelization = true)]
public sealed class MemoryPressureCollection;

[Collection(nameof(MemoryPressureTests))]
public sealed class MemoryPressureTests
{
    [Fact]
    public void PressureShrinksReaderCachesWithoutChangingResultsAndIsReported()
    {
        Assert.True(Environment.WorkingSet > 0, "Resident memory must be observable on this platform.");
        var root = Path.Combine(Path.GetTempPath(), "pci-memory-pressure-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        var original = MemoryPressure.ResidentBytes;
        try
        {
            var source = Path.Combine(root, "source"); Directory.CreateDirectory(source);
            File.WriteAllText(Path.Combine(source, "Example.cs"), string.Join('\n', Enumerable.Range(0, 40).Select(i => $"public class Example{i} {{ public int Run{i}() => {i}; }}")));
            using var runtime = new ServiceRuntime(Path.Combine(root, "data"));
            var id = runtime.Indexer.Register(source); runtime.Indexer.Index(id);
            (long Mapping, long Cache) Settings()
            {
                using var reader = runtime.Database.Open(readOnly: true); using var command = reader.CreateCommand();
                command.CommandText = "PRAGMA mmap_size"; var mapping = Convert.ToInt64(command.ExecuteScalar());
                command.CommandText = "PRAGMA cache_size"; return (mapping, Convert.ToInt64(command.ExecuteScalar()));
            }
            string Search() => runtime.Dispatch(new JsonObject { ["action"] = "query", ["tool"] = "search_code",
                ["arguments"] = new JsonObject { ["repositoryId"] = id, ["query"] = "Example7 Run", ["mode"] = "lexical" } }, CancellationToken.None)["data"]!.ToJsonString();
            JsonNode Memory() => runtime.Dispatch(new JsonObject { ["action"] = "doctor" }, CancellationToken.None)["data"]!["memory"]!;

            MemoryPressure.ResidentBytes = () => MemoryPressure.SoftLimitBytes - 1;
            Assert.Equal(-IndexDatabase.ReadPageCacheKiB, Settings().Cache);
            Assert.False(Memory()["pressure"]!.GetValue<bool>());
            var relaxed = Search();

            MemoryPressure.ResidentBytes = () => MemoryPressure.SoftLimitBytes;
            Assert.Equal((0L, -MemoryPressure.PressureReadPageCacheKiB), Settings());
            Assert.True(Memory()["pressure"]!.GetValue<bool>());
            Assert.Equal(MemoryPressure.SoftLimitBytes, Memory()["residentBytes"]!.GetValue<long>());
            Assert.Equal(relaxed, Search());
            // Publication under pressure runs its relief collection and still succeeds.
            File.AppendAllText(Path.Combine(source, "Example.cs"), "\npublic class Added { }");
            Assert.True(runtime.Indexer.Index(id).Changed);
            Assert.Empty(runtime.Database.Check());
        }
        finally { MemoryPressure.ResidentBytes = original; Directory.Delete(root, recursive: true); }
    }
}
