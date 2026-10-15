using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Praxis.CodeIntelligence.Embeddings;

public sealed record TokenizedChunk(long[] Tokens, int Start, int End, int FirstToken, int EndToken, bool Truncated);

public sealed class WordPieceTokenizer
{
    private sealed record Word(string Text, (int Start, int End)[] Positions);
    private sealed record Piece(long Id, int Start, int End);
    private readonly Dictionary<string, long> vocabulary;
    private static readonly Regex SpecialTokens = new(@"\[UNK\]|\[CLS\]|\[SEP\]|\[PAD\]|\[MASK\]", RegexOptions.CultureInvariant);
    public WordPieceTokenizer(IEnumerable<string> lines)
    {
        vocabulary = lines.Select((text, index) => (text, index)).ToDictionary(x => x.text, x => (long)x.index, StringComparer.Ordinal);
        foreach (var token in new[] { "[UNK]", "[CLS]", "[SEP]" }) if (!vocabulary.ContainsKey(token)) throw new ArgumentException("Tokenizer vocabulary lacks a required special token.");
    }
    public IReadOnlyList<long[]> EncodeChunks(string text, int maximumTokens = 256, int maximumChunks = 4) =>
        EncodeDetailed(text, maximumTokens, maximumChunks).Select(chunk => chunk.Tokens).ToArray();

    /// <summary>Chunk spans refer to the original input in UTF-16, excluding inserted CLS/SEP tokens.</summary>
    public IReadOnlyList<TokenizedChunk> EncodeDetailed(string text, int maximumTokens = 256, int maximumChunks = 4)
    {
        if (maximumTokens < 3 || maximumChunks is < 1 or > 4) throw new ArgumentException("Tokenizer limits are invalid.");
        var words = new List<Word>(); var current = new StringBuilder(); var positions = new List<(int Start, int End)>();
        void Flush()
        {
            if (current.Length == 0) return;
            words.Add(new(current.ToString(), positions.ToArray())); current.Clear(); positions.Clear();
        }
        void Ordinary(string segment, int offset)
        {
            foreach (var original in segment.EnumerateRunes())
            {
                var start = offset; offset += original.Utf16SequenceLength;
                // Normalize each scalar while retaining its original coordinate mapping.
                foreach (var rune in original.ToString().ToLowerInvariant().Normalize(NormalizationForm.FormD).ToLowerInvariant().EnumerateRunes())
                {
                    var category = Rune.GetUnicodeCategory(rune);
                    if (category == UnicodeCategory.NonSpacingMark) continue;
                    if (Rune.IsWhiteSpace(rune)) { Flush(); continue; }
                    if (category is UnicodeCategory.Control or UnicodeCategory.Format || rune.Value is 0 or 0xfffd) continue;
                    var value = rune.Value;
                    var punctuation = (value is >= 33 and <= 47 or >= 58 and <= 64 or >= 91 and <= 96 or >= 123 and <= 126)
                        || category is UnicodeCategory.ConnectorPunctuation or UnicodeCategory.DashPunctuation or UnicodeCategory.OpenPunctuation
                            or UnicodeCategory.ClosePunctuation or UnicodeCategory.InitialQuotePunctuation or UnicodeCategory.FinalQuotePunctuation or UnicodeCategory.OtherPunctuation;
                    var chinese = value is >= 0x4e00 and <= 0x9fff or >= 0x3400 and <= 0x4dbf
                        or >= 0x20000 and <= 0x2a6df or >= 0x2a700 and <= 0x2b73f or >= 0x2b740 and <= 0x2b81f
                        or >= 0x2b820 and <= 0x2ceaf or >= 0xf900 and <= 0xfaff or >= 0x2f800 and <= 0x2fa1f;
                    if (punctuation || chinese) Flush();
                    current.Append(rune.ToString());
                    for (var i = 0; i < rune.Utf16SequenceLength; i++) positions.Add((start, offset));
                    if (punctuation || chinese) Flush();
                }
            }
            Flush();
        }
        var previous = 0;
        foreach (Match match in SpecialTokens.Matches(text))
        {
            if (!vocabulary.ContainsKey(match.Value)) continue;
            Ordinary(text[previous..match.Index], previous);
            words.Add(new(match.Value, Enumerable.Range(match.Index, match.Length).Select(i => (i, i + 1)).ToArray()));
            previous = match.Index + match.Length;
        }
        Ordinary(text[previous..], previous);
        var pieces = new List<Piece>(); var capacity = maximumTokens - 2;
        foreach (var word in words)
        {
            if (word.Text.EnumerateRunes().Count() > 100)
                pieces.Add(new(vocabulary["[UNK]"], word.Positions[0].Start, word.Positions[^1].End));
            else
            {
                var wordPieces = new List<Piece>(); var start = 0; var failed = false;
                while (start < word.Text.Length)
                {
                    var end = word.Text.Length; long found = -1;
                    while (end > start)
                    {
                        var piece = (start == 0 ? "" : "##") + word.Text[start..end];
                        if (vocabulary.TryGetValue(piece, out found)) break; end--;
                    }
                    if (end == start) { failed = true; break; }
                    wordPieces.Add(new(found, word.Positions[start].Start, word.Positions[end - 1].End)); start = end;
                }
                if (failed) pieces.Add(new(vocabulary["[UNK]"], word.Positions[0].Start, word.Positions[^1].End));
                else pieces.AddRange(wordPieces);
            }
            if (pieces.Count > maximumChunks * capacity) break;
        }
        var result = new List<TokenizedChunk>(); var truncated = pieces.Count > maximumChunks * capacity;
        for (var offset = 0; offset < Math.Max(1, pieces.Count) && result.Count < maximumChunks; offset += capacity)
        {
            var chunk = pieces.Skip(offset).Take(capacity).ToArray();
            result.Add(new([vocabulary["[CLS]"], .. chunk.Select(piece => piece.Id), vocabulary["[SEP]"]],
                chunk.Length == 0 ? 0 : chunk[0].Start, chunk.Length == 0 ? 0 : chunk[^1].End,
                offset, offset + chunk.Length, truncated));
        }
        return result;
    }
}
