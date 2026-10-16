namespace Praxis.CodeIntelligence.Enrichment;

public interface ILocalLlmClient
{
    bool IsEnabled { get; }
    string Model { get; }
    Task<string> CompleteAsync(string systemPrompt, string userPrompt, CancellationToken cancellationToken);
}
