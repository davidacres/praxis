using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Praxis.CodeIntelligence.Enrichment;

/// <summary>
/// Connects to an OpenAI-compatible loopback HTTP LLM server (e.g. Ollama, llama.cpp, LocalAI).
/// Enforces loopback address validation, disabled redirects, and bounded 1,024-token output.
/// </summary>
public sealed class LocalLlmClient : ILocalLlmClient, IDisposable
{
    private readonly HttpClient client;
    private readonly Uri endpoint;
    private readonly bool ownsClient;

    public bool IsEnabled => true;
    public string Model { get; }

    public LocalLlmClient(Uri endpoint, string model, HttpClient? customClient = null)
    {
        LoopbackSecurity.ValidateLoopbackUri(endpoint);
        this.endpoint = endpoint;
        Model = string.IsNullOrWhiteSpace(model) ? "default" : model;
        if (customClient is not null)
        {
            client = customClient;
            ownsClient = false;
        }
        else
        {
            var handler = LoopbackSecurity.CreateSecureLoopbackHandler();
            client = new HttpClient(handler, disposeHandler: true)
            {
                Timeout = TimeSpan.FromSeconds(30)
            };
            ownsClient = true;
        }
    }

    public async Task<string> CompleteAsync(string systemPrompt, string userPrompt, CancellationToken cancellationToken)
    {
        var payload = new JsonObject
        {
            ["model"] = Model,
            ["messages"] = new JsonArray(
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = userPrompt }
            ),
            ["temperature"] = 0.0,
            ["max_tokens"] = 1024,
            ["response_format"] = new JsonObject { ["type"] = "json_object" }
        };

        using var content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = content };
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();

        var responseBytes = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
        if (responseBytes.Length > 64 * 1024)
            throw new InvalidOperationException("LLM response payload exceeded maximum allowed size of 64 KiB.");

        var responseJson = JsonNode.Parse(responseBytes) as JsonObject
            ?? throw new JsonException("LLM response is not a valid JSON object.");

        if (responseJson["choices"] is JsonArray choices && choices.Count > 0 &&
            choices[0] is JsonObject choice &&
            choice["message"] is JsonObject message &&
            message["content"] is JsonValue contentValue &&
            contentValue.TryGetValue<string>(out var text))
        {
            return text;
        }

        // Support direct text response if structured choices are absent
        if (responseJson["text"] is JsonValue directValue && directValue.TryGetValue<string>(out var directText))
            return directText;

        throw new JsonException("Could not extract message content from LLM response.");
    }

    public void Dispose()
    {
        if (ownsClient) client.Dispose();
    }
}
