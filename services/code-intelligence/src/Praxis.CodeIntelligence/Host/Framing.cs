using System.Buffers.Binary;
using System.Text.Json.Nodes;

namespace Praxis.CodeIntelligence.Host;

public static class Framing
{
    public const int MaximumRequestBytes = 1024 * 1024;
    public const int MaximumResponseBytes = 128 * 1024;
    public static async Task<JsonObject> ReadAsync(Stream stream, int maximumBytes, CancellationToken cancellationToken)
    {
        var header = new byte[4]; await stream.ReadExactlyAsync(header, cancellationToken);
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is <= 0 || length > maximumBytes) throw new IOException("Frame length exceeds protocol limits.");
        var payload = new byte[length]; await stream.ReadExactlyAsync(payload, cancellationToken);
        return JsonNode.Parse(payload, documentOptions: new() { MaxDepth = 64 })?.AsObject() ?? throw new IOException("Empty frame.");
    }
    public static async Task WriteAsync(Stream stream, JsonObject value, int maximumBytes, CancellationToken cancellationToken)
    {
        var payload = System.Text.Encoding.UTF8.GetBytes(value.ToJsonString());
        if (payload.Length > maximumBytes) throw new IOException("Response exceeds protocol limits.");
        var header = new byte[4]; BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        await stream.WriteAsync(header, cancellationToken); await stream.WriteAsync(payload, cancellationToken); await stream.FlushAsync(cancellationToken);
    }
}
