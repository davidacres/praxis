using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Queries;
using Praxis.CodeIntelligence.Storage;

namespace Praxis.CodeIntelligence.Host;

public sealed class ServiceRuntime
{
    public IndexDatabase Database { get; }
    public RepositoryIndexer Indexer { get; }
    private readonly QueryService queries;
    private readonly string grantsDirectory;
    public ServiceRuntime(string dataDirectory)
    {
        Directory.CreateDirectory(dataDirectory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(dataDirectory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        Database = new(Path.Combine(dataDirectory, "index.db")); Database.Initialize(); Indexer = new(Database); queries = new(Database);
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
                case "register": return Result(new { repositoryId = Indexer.Register(request["root"]!.GetValue<string>(),
                    new(request["manifest"]?.GetValue<string>(), request["excludes"]?.AsArray().Select(x => x!.GetValue<string>()).ToArray())) });
                case "index": return Result(Indexer.Index(repositoryId!, cancellationToken));
                case "pause": Indexer.SetPaused(repositoryId!, true); return Result(new { paused = true });
                case "resume": Indexer.SetPaused(repositoryId!, false); return Result(Indexer.Index(repositoryId!, cancellationToken));
                case "unregister":
                    foreach (var path in Directory.EnumerateFiles(grantsDirectory))
                    {
                        var grant = JsonNode.Parse(File.ReadAllText(path)); if (grant?["repositoryId"]?.GetValue<string>() == repositoryId) File.Delete(path);
                    }
                    Indexer.Unregister(repositoryId!); return Result(new { unregistered = true });
                case "grant":
                    Indexer.Get(repositoryId!); SaveGrant(repositoryId!, Client(request)); return Result(new { granted = true });
                case "revoke": File.Delete(GrantPath(repositoryId!, Client(request))); return Result(new { revoked = true });
                case "query":
                {
                    var arguments = request["arguments"]!.AsObject(); var id = arguments["repositoryId"]?.GetValue<string>() ?? "unknown";
                    var allowed = request["client"] is null || HasGrant(id, Client(request));
                    return queries.Execute(request["tool"]!.GetValue<string>(), arguments, allowed ? new HashSet<string> { id } : new HashSet<string>(), cancellationToken);
                }
                case "doctor": return Result(new { checks = Database.Check() });
                case "backup": Database.Backup(request["destination"]!.GetValue<string>()); return Result(new { backedUp = true });
                default: throw new ArgumentException("Unknown action.");
            }
        }
        catch (OperationCanceledException) { return Error("CANCELLED", "Operation cancelled."); }
        catch (KeyNotFoundException) { return Error("REPOSITORY_NOT_FOUND", "Repository is not registered."); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or System.Text.Json.JsonException)
        { return Error("OPERATION_FAILED", "Operation could not complete; check source access, passive context and owner state."); }
    }
    private static string Client(JsonObject request)
    {
        var client = request["client"]!.GetValue<string>();
        if (client.Length is < 1 or > 256) throw new ArgumentException("Client scope is invalid."); return client;
    }
    private string GrantPath(string id, string client) => Path.Combine(grantsDirectory, Identity.Id("", id, client) + ".json");
    private bool HasGrant(string id, string client)
    {
        var path = GrantPath(id, client); if (!File.Exists(path)) return false;
        var grant = JsonNode.Parse(File.ReadAllText(path)); return grant?["repositoryId"]?.GetValue<string>() == id && grant?["client"]?.GetValue<string>() == client;
    }
    private void SaveGrant(string id, string client)
    {
        var path = GrantPath(id, client); var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, new JsonObject { ["repositoryId"] = id, ["client"] = client }.ToJsonString());
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temporary, path, overwrite: true);
        }
        finally { File.Delete(temporary); }
    }
    public static JsonObject Result<T>(T data) => new() { ["data"] = System.Text.Json.JsonSerializer.SerializeToNode(data, new System.Text.Json.JsonSerializerOptions { PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase }) };
    public static JsonObject Error(string code, string message) => new() { ["error"] = new JsonObject { ["code"] = code, ["message"] = message, ["retryable"] = false } };
}
