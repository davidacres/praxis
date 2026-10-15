using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Host;
using Praxis.CodeIntelligence.Storage;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Embeddings;

var arguments = args.ToList();
string? Option(string name)
{
    var index = arguments.IndexOf(name); if (index < 0) return null;
    if (index + 1 >= arguments.Count) throw new ArgumentException("Option value is missing.");
    var value = arguments[index + 1]; arguments.RemoveRange(index, 2); return value;
}
try
{
    var directory = Option("--data") ?? HostPaths.DefaultDataDirectory();
    var manifest = Option("--manifest"); var excludes = Option("--exclude"); var client = Option("--client");
    var output = Option("--output"); var configuration = Option("--configuration"); var framework = Option("--framework"); var restore = arguments.Remove("--restore");
    if (arguments.Count == 0 || arguments[0] is "help" or "--help")
    {
        Console.WriteLine("Praxis Code Intelligence\n" +
            "register <root> [--manifest context.praxis.json] [--exclude folder;folder]\n" +
            "list | index <repository> | pause <repository> | resume <repository> | unregister <repository>\n" +
            "status <repository> | search <repository> <query> | query <tool> <JSON arguments>\n" +
            "grant <repository> --client <provider> | revoke <repository> --client <provider>\n" +
            "rpc --client <provider> (one tool/arguments JSON object on stdin)\n" +
            "capture <root> <relative.csproj> [--output context.praxis.json] [--configuration Debug] [--framework net10.0] [--restore]\n" +
            "model-check <bundle> | model-install <bundle> | model-activate <repository> <fingerprint>\n" +
            "alias <repository> <symbolId> <phrase>\n" +
            "doctor | backup <destination> | serve\nAll commands accept --data <private directory>. Normal indexing never builds or restores projects."); return 0;
    }
    if (arguments[0] == "init" && arguments.Count == 2) { new IndexDatabase(arguments[1]).Initialize(); Console.WriteLine("Index initialized."); return 0; }
    using var cancellation = new CancellationTokenSource(); Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };
    if (arguments[0] == "model-check" && arguments.Count == 2)
    {
        using var model = new LocalModel(arguments[1]);
        var vector = model.EmbedQuery("Praxis code intelligence", cancellation.Token); LocalModel.ValidateVector(vector);
        Console.WriteLine(new JsonObject { ["fingerprint"] = model.Fingerprint, ["dimensions"] = vector.Length, ["normalized"] = true }.ToJsonString()); return 0;
    }
    if (arguments[0] == "capture" && arguments.Count == 3)
    {
        Console.Error.WriteLine("Explicit context capture evaluates projects and MSBuild targets and may execute project code." + (restore ? " Restore is enabled and may contact configured package feeds." : " Restore is disabled."));
        var captured = await ContextCapture.CaptureAsync(arguments[1], arguments[2], output ?? "context.praxis.json", configuration ?? "Debug", framework, restore, cancellation.Token);
        Console.WriteLine(new JsonObject { ["manifest"] = captured }.ToJsonString()); return 0;
    }
    if (arguments[0] == "serve") { await OwnerService.RunAsync(directory, cancellation.Token); return 0; }
    JsonObject request = arguments[0] switch
    {
        "list" or "doctor" when arguments.Count == 1 => new() { ["action"] = arguments[0] },
        "register" when arguments.Count == 2 => new() { ["action"] = "register", ["root"] = arguments[1], ["manifest"] = manifest,
            ["excludes"] = excludes is null ? null : new JsonArray(excludes.Split(';', StringSplitOptions.RemoveEmptyEntries).Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()) },
        "index" or "pause" or "resume" or "unregister" or "grant" or "revoke" when arguments.Count == 2 => new() { ["action"] = arguments[0], ["repositoryId"] = arguments[1], ["client"] = client },
        "status" when arguments.Count == 2 => new() { ["action"] = "query", ["tool"] = "get_index_status", ["arguments"] = new JsonObject { ["repositoryId"] = arguments[1] } },
        "search" when arguments.Count == 3 => new() { ["action"] = "query", ["tool"] = "search_code", ["arguments"] = new JsonObject { ["repositoryId"] = arguments[1], ["query"] = arguments[2] } },
        "query" when arguments.Count == 3 => new() { ["action"] = "query", ["tool"] = arguments[1], ["arguments"] = JsonNode.Parse(arguments[2])!.AsObject() },
        "backup" when arguments.Count == 2 => new() { ["action"] = "backup", ["destination"] = arguments[1] },
        "model-install" when arguments.Count == 2 => new() { ["action"] = "model-install", ["bundle"] = arguments[1] },
        "model-activate" when arguments.Count == 3 => new() { ["action"] = "model-activate", ["repositoryId"] = arguments[1], ["fingerprint"] = arguments[2] },
        "alias" when arguments.Count == 4 => new() { ["action"] = "alias", ["repositoryId"] = arguments[1], ["symbolId"] = arguments[2], ["phrase"] = arguments[3] },
        "rpc" when arguments.Count == 1 && client is not null => await ReadRpc(client),
        "local-rpc" when arguments.Count == 1 => await ReadRpc(null),
        _ => throw new ArgumentException("Invalid command or arguments; run help.")
    };
    var result = await OwnerService.SendAsync(directory, request, cancellation.Token); Console.WriteLine(result.ToJsonString()); return result.ContainsKey("error") ? 5 : 0;
}
catch (OperationCanceledException) { Console.Error.WriteLine("CANCELLED"); return 4; }
catch (Exception ex) when (ex is ArgumentException or System.Text.Json.JsonException) { Console.Error.WriteLine("INVALID_ARGUMENT: " + ex.Message); return 2; }
catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException) { Console.Error.WriteLine("OPERATION_FAILED: " + ex.Message); return 5; }

static async Task<JsonObject> ReadRpc(string? client)
{
    using var input = Console.OpenStandardInput(); using var buffer = new MemoryStream(); var chunk = new byte[8192]; int count;
    while ((count = await input.ReadAsync(chunk)) > 0)
    {
        if (buffer.Length + count > Framing.MaximumRequestBytes) throw new ArgumentException("RPC input exceeds limit."); buffer.Write(chunk, 0, count);
    }
    var request = JsonNode.Parse(buffer.ToArray())!.AsObject(); request["action"] = "query"; request["client"] = client;
    foreach (var key in request.Select(p => p.Key).ToArray()) if (key is not ("action" or "client" or "tool" or "arguments")) throw new ArgumentException("Unknown RPC field."); return request;
}
