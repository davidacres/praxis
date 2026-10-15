using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Praxis.CodeIntelligence.Queries;

public sealed class CursorCodec
{
    private readonly byte[] secret = RandomNumberGenerator.GetBytes(32);
    public string Create(string tool, JsonObject arguments, long epoch, int offset)
    {
        var payload = Encoding.UTF8.GetBytes(new JsonObject
        { ["tool"] = tool, ["arguments"] = ArgumentHash(arguments), ["epoch"] = epoch, ["offset"] = offset,
          ["expires"] = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds() }.ToJsonString());
        return Convert.ToBase64String(payload) + "." + Convert.ToBase64String(HMACSHA256.HashData(secret, payload));
    }
    public int Read(string encoded, string tool, JsonObject arguments, long epoch)
    {
        try
        {
            var parts = encoded.Split('.'); if (parts.Length != 2) throw new FormatException();
            var payload = Convert.FromBase64String(parts[0]); var mac = Convert.FromBase64String(parts[1]);
            if (!CryptographicOperations.FixedTimeEquals(mac, HMACSHA256.HashData(secret, payload))) throw new FormatException();
            var obj = JsonNode.Parse(payload)!.AsObject();
            if (obj["expires"]!.GetValue<long>() < DateTimeOffset.UtcNow.ToUnixTimeSeconds() || obj["epoch"]!.GetValue<long>() != epoch)
                throw new QueryException("CURSOR_EXPIRED", "Restart the query against the current index.");
            if (obj["tool"]!.GetValue<string>() != tool || obj["arguments"]!.GetValue<string>() != ArgumentHash(arguments))
                throw new QueryException("INVALID_ARGUMENT", "Cursor arguments changed.");
            var offset = obj["offset"]!.GetValue<int>(); if (offset < 0) throw new FormatException(); return offset;
        }
        catch (QueryException) { throw; }
        catch (Exception ex) when (ex is FormatException or System.Text.Json.JsonException or InvalidOperationException)
        { throw new QueryException("CURSOR_EXPIRED", "Cursor is invalid or belongs to a previous owner."); }
    }
    private static string ArgumentHash(JsonObject arguments) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(arguments))));
    private static string Canonical(JsonNode value) => value switch
    {
        JsonObject obj => "{" + string.Join(',', obj.Where(p => p.Key != "cursor").OrderBy(p => p.Key, StringComparer.Ordinal)
            .Select(p => System.Text.Json.JsonSerializer.Serialize(p.Key) + ":" + (p.Value is null ? "null" : Canonical(p.Value)))) + "}",
        JsonArray array => "[" + string.Join(',', array.Select(x => x is null ? "null" : Canonical(x))) + "]",
        _ => value.ToJsonString()
    };
}
