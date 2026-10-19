using System.Text.RegularExpressions;

namespace Praxis.CodeIntelligence.Embeddings;

public sealed record SemanticHeaderSymbol(string Id, string Name, string QualifiedName, string Signature, string Kind, string Documentation, string Language = "unknown");

/// <summary>Bounded, deterministic source facts; no generated answers or query labels.</summary>
public static class SemanticHeaderBuilder
{
    private static string Words(string value)
    {
        value = Regex.Replace(value, @"<anonymous>#\d+", "callback", RegexOptions.CultureInvariant);
        value = Regex.Replace(value, @"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", RegexOptions.CultureInvariant);
        return string.Join(' ', Regex.Matches(value, @"[\p{L}][\p{L}\p{N}]*", RegexOptions.CultureInvariant).Select(match => match.Value));
    }
    private static string Bound(string text, int length)
    {
        var end = Math.Min(text.Length, length);
        if (end > 0 && end < text.Length && char.IsHighSurrogate(text[end - 1])) end--;
        return text[..end];
    }
    public static IReadOnlyDictionary<string, string> Build(IEnumerable<SemanticHeaderSymbol> symbols, IEnumerable<(string Source, string Target)> calls)
    {
        var all = symbols.ToDictionary(symbol => symbol.Id, StringComparer.Ordinal);
        var pairs = calls.Where(call => all.ContainsKey(call.Source) && all.ContainsKey(call.Target)).Distinct().ToArray();
        var callers = pairs.ToLookup(call => call.Target, call => call.Source, StringComparer.Ordinal);
        var callees = pairs.ToLookup(call => call.Source, call => call.Target, StringComparer.Ordinal);
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var symbol in all.Values.Where(symbol => symbol.Language is "typescript" or "javascript"))
        {
            var module = symbol.QualifiedName[(symbol.QualifiedName.LastIndexOf('/') + 1)..].Split('.')[0];
            var text = $"{symbol.Kind}: {Words(symbol.Name)}. Context: {Words(module)}. " + Bound(symbol.Documentation.Replace("\\n", "\n", StringComparison.Ordinal), 1000);
            text += "\nSignature: " + Bound(Words(symbol.Signature.Replace(symbol.QualifiedName, symbol.Name, StringComparison.Ordinal)), 350);
            var incoming = callers[symbol.Id].Order(StringComparer.Ordinal).Take(2).ToArray();
            if (incoming.Length > 0) text += "\nUsed by: " + string.Join("; ", incoming.Select(id => Words(all[id].Name) + ": " + Bound(all[id].Documentation.Replace("\\n", " ", StringComparison.Ordinal), 180)));
            var outgoing = callees[symbol.Id].Order(StringComparer.Ordinal).Take(8).ToArray();
            if (outgoing.Length > 0) text += "\nCalls: " + string.Join(", ", outgoing.Select(id => Words(all[id].Name)));
            result[symbol.Id] = Bound(text, 4096);
        }
        return result;
    }
}
