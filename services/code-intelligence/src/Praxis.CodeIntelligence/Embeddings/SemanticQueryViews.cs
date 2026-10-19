using System.Text.RegularExpressions;

namespace Praxis.CodeIntelligence.Embeddings;

/// <summary>Bounded semantic views of the user's words, with no lexical retrieval.</summary>
public static class SemanticQueryViews
{
    public static IReadOnlyList<string> Create(string query)
    {
        var text = query.Trim().TrimEnd('?');
        var compact = Regex.Replace(text, @"^(?:where|how|which|what)\s+(?:(?:is|are|does|do|can|function|helper|code|predicate|method)\s+){0,3}", "", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if (string.IsNullOrWhiteSpace(compact)) return [query];
        var clauses = Regex.Split(compact, @"\b(?:and|when|while|then|before|after|without)\b|[,;]", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
            .Select(part => part.Trim(' ', ',', '.', '?')).Where(part => part.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length >= 4).ToArray();
        var values = new List<string> { query, compact, "Source code that implements: " + compact };
        if (clauses.Length > 1) { values.Add(clauses[0]); values.Add(clauses[^1]); }
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        return values.Where(value => !string.IsNullOrWhiteSpace(value) && seen.Add(Regex.Replace(value, @"\s+", " ").Trim())).ToArray();
    }
}
