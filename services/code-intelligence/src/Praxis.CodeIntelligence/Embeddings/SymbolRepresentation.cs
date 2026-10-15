using System.Text;
using Praxis.CodeIntelligence.Indexing;

namespace Praxis.CodeIntelligence.Embeddings;

public sealed record RepresentationSource(string Path, string ContentHash, int Start, int End, int RepresentationStart, int RepresentationEnd);
public sealed record SymbolRepresentation(string Text, string Hash, bool Truncated, IReadOnlyList<RepresentationSource> Sources);

public static class RepresentationBuilder
{
    public static SymbolRepresentation Build(string name, string signature, string documentation, string description,
        SourceInput? source = null, int sourceStart = 0, int sourceEnd = 0)
    {
        const int maximum = 16384;
        var text = new StringBuilder(); var truncated = false; var spans = new List<RepresentationSource>();
        void Append(string value)
        {
            if (text.Length > 0 && text.Length < maximum) text.Append('\n');
            var length = Math.Min(value.Length, maximum - text.Length);
            if (length > 0 && length < value.Length && char.IsHighSurrogate(value[length - 1])) length--;
            text.Append(value.AsSpan(0, length)); truncated |= length != value.Length;
        }
        Append(name); Append(signature); Append(documentation); Append(description);
        if (source is not null)
        {
            if (sourceStart < 0 || sourceEnd < sourceStart || sourceEnd > source.Text.Length) throw new IOException("INDEX_STALE: source declaration span changed.");
            if (text.Length < maximum) text.Append('\n');
            var start = text.Length;
            var length = Math.Min(Math.Min(sourceEnd - sourceStart, 4096), maximum - start);
            if (length > 0 && sourceStart + length < source.Text.Length && char.IsHighSurrogate(source.Text[sourceStart + length - 1])) length--;
            text.Append(source.Text.AsSpan(sourceStart, length));
            if (length > 0) spans.Add(new(source.Path, source.Hash, sourceStart, sourceStart + length, start, text.Length));
            truncated |= length != sourceEnd - sourceStart;
        }
        var value = text.ToString();
        return new(value, SourceFiles.Hash(Encoding.UTF8.GetBytes(value)), truncated, spans);
    }
}
