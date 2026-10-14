using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Praxis.CodeIntelligence.Queries;

public sealed class QueryException(string code, string message) : Exception(message) { public string Code { get; } = code; }

public static class JsonContract
{
    public static readonly JsonObject Contracts = Load();
    public static IReadOnlyList<string> ToolNames => Contracts.Select(x => x.Key).ToArray();
    private static JsonObject Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Praxis.CodeIntelligence.contracts.json")!;
        return JsonNode.Parse(stream)!.AsObject();
    }
    public static void Validate(string tool, JsonObject arguments)
    {
        if (!Contracts.TryGetPropertyValue(tool, out var contract)) throw new QueryException("INVALID_ARGUMENT", "Unknown query tool.");
        Check(contract!["inputSchema"]!, arguments);
        if (tool == "get_source")
        {
            var symbol = arguments.ContainsKey("symbolId"); var file = arguments.ContainsKey("fileId");
            if (symbol == file || (file && (!arguments.ContainsKey("range") || arguments.ContainsKey("locationId")))
                || (symbol && (arguments.ContainsKey("range") || (arguments.ContainsKey("expectedContentHash") && !arguments.ContainsKey("locationId")))))
                throw new QueryException("INVALID_ARGUMENT", "Choose a symbol selector or a file/range selector; expected symbol hashes require locationId.");
        }
    }
    private static void Check(JsonNode schema, JsonNode? value)
    {
        var type = schema["type"]?.GetValue<string>();
        if (value is null) throw new QueryException("INVALID_ARGUMENT", "Null query arguments are unsupported.");
        if (type == "object")
        {
            if (value is not JsonObject obj) Fail();
            var data = value.AsObject(); var properties = schema["properties"]!.AsObject();
            foreach (var required in schema["required"]?.AsArray() ?? []) if (!data.ContainsKey(required!.GetValue<string>())) Fail();
            foreach (var field in data) { if (!properties.ContainsKey(field.Key)) Fail(); Check(properties[field.Key]!, field.Value); }
        }
        else if (type == "array")
        {
            if (value is not JsonArray array || array.Count > (schema["maxItems"]?.GetValue<int>() ?? int.MaxValue)) Fail();
            foreach (var item in value.AsArray()) Check(schema["items"]!, item);
        }
        else if (type == "string")
        {
            if (value is not JsonValue v || !v.TryGetValue<string>(out var text)) { Fail(); return; }
            if (text.Length < (schema["minLength"]?.GetValue<int>() ?? 0) || text.Length > (schema["maxLength"]?.GetValue<int>() ?? int.MaxValue)) Fail();
            if (schema["enum"] is JsonArray allowed && !allowed.Any(x => x!.GetValue<string>() == text)) Fail();
            if (schema["pattern"] is JsonValue pattern && !Regex.IsMatch(text, pattern.GetValue<string>(), RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50))) Fail();
        }
        else if (type == "integer")
        {
            if (value is not JsonValue v || !v.TryGetValue<int>(out var number)) { Fail(); return; }
            if (number < (schema["minimum"]?.GetValue<int>() ?? int.MinValue) || number > (schema["maximum"]?.GetValue<int>() ?? int.MaxValue)) Fail();
        }
        else if (type == "boolean" && (value is not JsonValue boolean || !boolean.TryGetValue<bool>(out _))) Fail();
    }
    private static void Fail() => throw new QueryException("INVALID_ARGUMENT", "Query arguments do not satisfy the tool schema.");
}
