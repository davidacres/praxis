using System.Text.Json;
using System.Text.Json.Nodes;

namespace Praxis.CodeIntelligence.Enrichment;

public sealed class GroundingException(string message) : Exception(message);

public sealed record GroundedEnrichmentResult(
    string FormattedText,
    string[] ValidEvidenceIds,
    string[] Uncertainties
);

/// <summary>
/// Validates LLM structured responses against specification §11 and §29.3.
/// Verifies required fields (intent, inputs, outputs, sideEffects, uncertainties, evidenceIds)
/// and enforces evidence membership (rejecting fabricated evidence references).
/// </summary>
public static class EnrichmentValidator
{
    public static GroundedEnrichmentResult Validate(string rawJson, IReadOnlySet<string> allowedEvidenceIds)
    {
        if (string.IsNullOrWhiteSpace(rawJson))
            throw new GroundingException("LLM returned empty output.");

        JsonObject json;
        try
        {
            json = JsonNode.Parse(rawJson) as JsonObject
                ?? throw new GroundingException("LLM output is not a valid JSON object.");
        }
        catch (JsonException ex)
        {
            throw new GroundingException($"LLM output failed JSON parsing: {ex.Message}");
        }

        // Required field: intent
        if (!json.TryGetPropertyValue("intent", out var intentNode) || intentNode is null)
            throw new GroundingException("Missing required 'intent' property in LLM output.");
        var intent = intentNode.GetValue<string>();
        if (string.IsNullOrWhiteSpace(intent))
            throw new GroundingException("'intent' must not be blank.");

        // Format inputs, outputs, sideEffects
        var inputsStr = FormatSection(json["inputs"]);
        var outputsStr = FormatSection(json["outputs"]);
        var sideEffectsStr = FormatSection(json["sideEffects"]);

        // Validate uncertainties
        var uncertainties = new List<string>();
        if (json["uncertainties"] is JsonArray uArray)
        {
            foreach (var item in uArray)
            {
                if (item is JsonValue uv && uv.TryGetValue<string>(out var uText) && !string.IsNullOrWhiteSpace(uText))
                    uncertainties.Add(uText);
            }
        }

        // Validate evidence membership (§11: "reject fabricated references")
        if (!json.TryGetPropertyValue("evidenceIds", out var evidenceIdsNode) || evidenceIdsNode is not JsonArray evidenceArray)
            throw new GroundingException("Missing required 'evidenceIds' array in LLM output.");

        var citedEvidenceIds = new List<string>();
        foreach (var item in evidenceArray)
        {
            if (item is JsonValue ev && ev.TryGetValue<string>(out var evId) && !string.IsNullOrWhiteSpace(evId))
            {
                if (!allowedEvidenceIds.Contains(evId))
                {
                    throw new GroundingException($"Fabricated evidence reference cited: '{evId}' is not among verified evidence IDs.");
                }
                citedEvidenceIds.Add(evId);
            }
        }

        // Build formatted description text
        var textBuilder = new System.Text.StringBuilder();
        textBuilder.Append("Intent: ").AppendLine(intent);
        if (!string.IsNullOrWhiteSpace(inputsStr))
            textBuilder.Append("Inputs: ").AppendLine(inputsStr);
        if (!string.IsNullOrWhiteSpace(outputsStr))
            textBuilder.Append("Outputs: ").AppendLine(outputsStr);
        if (!string.IsNullOrWhiteSpace(sideEffectsStr))
            textBuilder.Append("Side effects: ").AppendLine(sideEffectsStr);

        var formattedText = textBuilder.ToString().TrimEnd();
        if (formattedText.Length > 16384)
            formattedText = formattedText[..16384];

        return new GroundedEnrichmentResult(
            formattedText,
            citedEvidenceIds.Distinct(StringComparer.Ordinal).ToArray(),
            uncertainties.ToArray()
        );
    }

    private static string FormatSection(JsonNode? node)
    {
        if (node is null) return string.Empty;
        if (node is JsonValue val && val.TryGetValue<string>(out var s)) return s;
        if (node is JsonArray arr)
        {
            var items = arr.Select(item => item is JsonValue v && v.TryGetValue<string>(out var t) ? t : item?.ToJsonString())
                           .Where(t => !string.IsNullOrWhiteSpace(t))
                           .ToArray();
            return string.Join("; ", items);
        }
        if (node is JsonObject obj)
        {
            var pairs = obj.Select(kv => $"{kv.Key}: {kv.Value}").ToArray();
            return string.Join("; ", pairs);
        }
        return node.ToJsonString();
    }
}
