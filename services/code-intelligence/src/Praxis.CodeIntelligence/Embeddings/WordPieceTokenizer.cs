using System.Globalization;
using System.Text;

namespace Praxis.CodeIntelligence.Embeddings;

public sealed class WordPieceTokenizer
{
    private readonly Dictionary<string, long> vocabulary;
    public WordPieceTokenizer(IEnumerable<string> lines)
    {
        vocabulary = lines.Select((text, index) => (text, index)).ToDictionary(x => x.text, x => (long)x.index, StringComparer.Ordinal);
        foreach (var token in new[] { "[UNK]", "[CLS]", "[SEP]" }) if (!vocabulary.ContainsKey(token)) throw new ArgumentException("Tokenizer vocabulary lacks a required special token.");
    }
    public IReadOnlyList<long[]> EncodeChunks(string text, int maximumTokens = 256, int maximumChunks = 4)
    {
        if (maximumTokens < 3 || maximumChunks is < 1 or > 4) throw new ArgumentException("Tokenizer limits are invalid.");
        var words = new List<string>(); var current = new StringBuilder();
        void Flush() { if (current.Length > 0) { words.Add(current.ToString()); current.Clear(); } }
        // BERT added tokens are case-sensitive and bypass ordinary normalization.
        foreach (var segment in System.Text.RegularExpressions.Regex.Split(text, @"(\[UNK\]|\[CLS\]|\[SEP\]|\[PAD\]|\[MASK\])"))
        {
            if (segment is "[UNK]" or "[CLS]" or "[SEP]" or "[PAD]" or "[MASK]" && vocabulary.ContainsKey(segment))
            { Flush(); words.Add(segment); continue; }
            foreach (var rune in segment.ToLowerInvariant().Normalize(NormalizationForm.FormD).EnumerateRunes())
            {
                var category = Rune.GetUnicodeCategory(rune);
                if (category == UnicodeCategory.NonSpacingMark) continue;
                if (Rune.IsWhiteSpace(rune)) { Flush(); continue; }
                if (category is UnicodeCategory.Control or UnicodeCategory.Format) continue;
                var value = rune.Value;
                var punctuation = (value is >= 33 and <= 47 or >= 58 and <= 64 or >= 91 and <= 96 or >= 123 and <= 126)
                    || category is UnicodeCategory.ConnectorPunctuation or UnicodeCategory.DashPunctuation or UnicodeCategory.OpenPunctuation
                        or UnicodeCategory.ClosePunctuation or UnicodeCategory.InitialQuotePunctuation or UnicodeCategory.FinalQuotePunctuation or UnicodeCategory.OtherPunctuation;
                var chinese = value is >= 0x4e00 and <= 0x9fff or >= 0x3400 and <= 0x4dbf or >= 0x20000 and <= 0x2fa1f;
                if (punctuation || chinese) { Flush(); words.Add(rune.ToString()); } else current.Append(rune.ToString());
            }
            Flush();
        }
        var pieces = new List<long>();
        foreach (var word in words)
        {
            if (word.Length > 100) { pieces.Add(vocabulary["[UNK]"]); continue; }
            var wordPieces = new List<long>(); var start = 0; var failed = false;
            while (start < word.Length)
            {
                var end = word.Length; long found = -1;
                while (end > start)
                {
                    var piece = (start == 0 ? "" : "##") + word[start..end];
                    if (vocabulary.TryGetValue(piece, out found)) break; end--;
                }
                if (end == start) { failed = true; break; }
                wordPieces.Add(found); start = end;
            }
            if (failed) pieces.Add(vocabulary["[UNK]"]); else pieces.AddRange(wordPieces);
            if (pieces.Count > maximumChunks * (maximumTokens - 2)) break;
        }
        var result = new List<long[]>(); var capacity = maximumTokens - 2;
        for (var offset = 0; offset < Math.Max(1, pieces.Count) && result.Count < maximumChunks; offset += capacity)
            result.Add([vocabulary["[CLS]"], .. pieces.Skip(offset).Take(capacity), vocabulary["[SEP]"]]);
        return result;
    }
}
