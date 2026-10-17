using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Praxis.CodeIntelligence.Indexing.Documents;

public sealed class MarkdownDocumentChunker : IDocumentParser
{
    private sealed record LineSpan(int LineNumber, string Text, int StartOffset, int EndOffset);
    private sealed record ParagraphBlock(string Text, int StartLine, int EndLine, int StartOffset, int EndOffset);

    public bool CanParse(string relativePath)
    {
        var ext = Path.GetExtension(relativePath);
        return ext.Equals(".md", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".markdown", StringComparison.OrdinalIgnoreCase)
            || ext.Equals(".txt", StringComparison.OrdinalIgnoreCase);
    }

    public ParsedDocument Parse(string relativePath, byte[] bytes, string root)
    {
        var text = SourceFiles.Decode(bytes);
        var pathKey = DocumentModelHelpers.ToPathKey(relativePath);
        var contentHash = SourceFiles.Hash(bytes);
        var ext = Path.GetExtension(relativePath).TrimStart('.').ToLowerInvariant();
        var docType = ext is "md" or "markdown" ? "markdown" : ext;

        var (frontmatterJson, explicitTitle, contentStartLineIndex, lineSpans) = ParseLinesAndFrontmatter(text, relativePath);
        var sections = ChunkContent(lineSpans, contentStartLineIndex, explicitTitle, relativePath);

        var title = explicitTitle;
        if (string.IsNullOrWhiteSpace(title))
        {
            var firstH1 = sections.FirstOrDefault(s => !string.IsNullOrWhiteSpace(s.Heading));
            title = firstH1?.Heading ?? Path.GetFileNameWithoutExtension(relativePath);
        }

        return new ParsedDocument(
            relativePath,
            pathKey,
            contentHash,
            docType,
            title,
            frontmatterJson,
            bytes.Length,
            sections);
    }

    private static (string FrontmatterJson, string? Title, int ContentStartLineIndex, List<LineSpan> LineSpans)
        ParseLinesAndFrontmatter(string text, string relativePath)
    {
        var lineSpans = SplitLineSpans(text);
        if (lineSpans.Count == 0)
            return ("{}", null, 0, lineSpans);

        // Case 1: YAML / Frontmatter fence starting with ---
        if (lineSpans[0].Text.Trim() == "---")
        {
            int closingIndex = -1;
            for (int i = 1; i < lineSpans.Count; i++)
            {
                var trimmed = lineSpans[i].Text.Trim();
                if (trimmed is "---" or "...")
                {
                    closingIndex = i;
                    break;
                }
            }

            if (closingIndex > 0)
            {
                var fmLines = lineSpans.Skip(1).Take(closingIndex - 1).Select(l => l.Text).ToList();
                var (json, title) = ParseFrontmatterLines(fmLines);
                return (json, title, closingIndex + 1, lineSpans);
            }
        }

        // Case 2: Praxis frontmatter without --- fence (e.g. **Status:**, id: FX-...)
        var leadingFmLines = new List<string>();
        int idx = 0;
        while (idx < lineSpans.Count)
        {
            var trimmed = lineSpans[idx].Text.Trim();
            if (string.IsNullOrWhiteSpace(trimmed))
            {
                if (leadingFmLines.Count > 0) { idx++; break; }
                idx++;
                continue;
            }
            if (trimmed.StartsWith("#")) break; // Headings stop frontmatter

            if (IsPraxisOrYamlLine(trimmed))
            {
                leadingFmLines.Add(trimmed);
                idx++;
            }
            else
            {
                break;
            }
        }

        if (leadingFmLines.Count > 0)
        {
            var (json, title) = ParseFrontmatterLines(leadingFmLines);
            return (json, title, idx, lineSpans);
        }

        return ("{}", null, 0, lineSpans);
    }

    private static bool IsPraxisOrYamlLine(string line)
    {
        if (line.StartsWith("**") && line.Contains(":**")) return true;
        if (Regex.IsMatch(line, @"^[a-zA-Z0-9_-]+:\s")) return true;
        return false;
    }

    private static (string Json, string? Title) ParseFrontmatterLines(IReadOnlyList<string> lines)
    {
        var dict = new Dictionary<string, object>(StringComparer.Ordinal);
        string? currentKey = null;
        List<string>? currentList = null;

        foreach (var rawLine in lines)
        {
            var line = rawLine.Trim();
            if (string.IsNullOrWhiteSpace(line) || line.StartsWith("#")) continue;

            // Handle list items: - value
            if (line.StartsWith("- ") && currentKey is not null)
            {
                if (currentList is null)
                {
                    currentList = new List<string>();
                    dict[currentKey] = currentList;
                }
                currentList.Add(line[2..].Trim().Trim('"', '\''));
                continue;
            }

            currentList = null;

            // Handle Praxis format: **Key:** Value
            if (line.StartsWith("**"))
            {
                var colonIdx = line.IndexOf(':');
                if (colonIdx > 2)
                {
                    var rawKey = line[..colonIdx].Replace("*", "").Trim();
                    var rawVal = line[(colonIdx + 1)..].Replace("*", "").Trim().Trim('"', '\'');
                    dict[rawKey] = rawVal;
                    currentKey = rawKey;
                    continue;
                }
            }

            // Handle standard key: value
            var sep = line.IndexOf(':');
            if (sep > 0)
            {
                var key = line[..sep].Trim();
                var val = line[(sep + 1)..].Trim().Trim('"', '\'');
                if (!string.IsNullOrEmpty(val))
                {
                    dict[key] = val;
                }
                currentKey = key;
            }
        }

        string? title = null;
        if (dict.TryGetValue("title", out var titleObj) || dict.TryGetValue("Title", out titleObj))
            title = titleObj?.ToString();

        var json = JsonSerializer.Serialize(dict);
        return (json, title);
    }

    private static List<LineSpan> SplitLineSpans(string text)
    {
        var spans = new List<LineSpan>();
        int lineNum = 1;
        int start = 0;

        for (int i = 0; i < text.Length; i++)
        {
            if (text[i] == '\n')
            {
                int end = (i > start && text[i - 1] == '\r') ? i - 1 : i;
                spans.Add(new LineSpan(lineNum++, text[start..end], start, i));
                start = i + 1;
            }
        }
        if (start <= text.Length)
        {
            spans.Add(new LineSpan(lineNum, text[start..], start, text.Length));
        }
        return spans;
    }

    private static IReadOnlyList<DocumentSection> ChunkContent(
        IReadOnlyList<LineSpan> lineSpans,
        int contentStartLineIndex,
        string? documentTitle,
        string relativePath)
    {
        var sections = new List<DocumentSection>();
        var headingStack = new List<(int Level, string Heading)>();
        bool inCodeFence = false;

        string currentHeading = documentTitle ?? Path.GetFileNameWithoutExtension(relativePath);
        string currentHeadingPath = currentHeading;
        int headingLine = contentStartLineIndex < lineSpans.Count ? lineSpans[contentStartLineIndex].LineNumber : 1;
        int headingOffset = contentStartLineIndex < lineSpans.Count ? lineSpans[contentStartLineIndex].StartOffset : 0;

        var currentParagraphs = new List<ParagraphBlock>();
        var currentParaLines = new List<LineSpan>();

        void FlushCurrentParagraph()
        {
            if (currentParaLines.Count == 0) return;
            var paraText = string.Join("\n", currentParaLines.Select(l => l.Text));
            if (!string.IsNullOrWhiteSpace(paraText))
            {
                currentParagraphs.Add(new ParagraphBlock(
                    paraText,
                    currentParaLines[0].LineNumber,
                    currentParaLines[^1].LineNumber,
                    currentParaLines[0].StartOffset,
                    currentParaLines[^1].EndOffset));
            }
            currentParaLines.Clear();
        }

        void FlushSection()
        {
            FlushCurrentParagraph();
            if (currentParagraphs.Count == 0) return;

            EmitBoundedSections(sections, currentParagraphs, currentHeading, currentHeadingPath, headingLine, headingOffset);
            currentParagraphs.Clear();
        }

        for (int i = contentStartLineIndex; i < lineSpans.Count; i++)
        {
            var span = lineSpans[i];
            var trimmed = span.Text.Trim();

            // Code fence toggle
            if (trimmed.StartsWith("```") || trimmed.StartsWith("~~~"))
            {
                inCodeFence = !inCodeFence;
                currentParaLines.Add(span);
                continue;
            }

            if (!inCodeFence && trimmed.StartsWith("#"))
            {
                // Count heading level
                int level = 0;
                while (level < trimmed.Length && trimmed[level] == '#') level++;

                if (level >= 1 && level <= 6 && (level == trimmed.Length || trimmed[level] == ' '))
                {
                    var headingText = trimmed[level..].Trim();
                    if (!string.IsNullOrWhiteSpace(headingText))
                    {
                        FlushSection();

                        while (headingStack.Count > 0 && headingStack[^1].Level >= level)
                        {
                            headingStack.RemoveAt(headingStack.Count - 1);
                        }
                        headingStack.Add((level, headingText));

                        currentHeading = headingText;
                        currentHeadingPath = string.Join(" > ", headingStack.Select(h => h.Heading));
                        headingLine = span.LineNumber;
                        headingOffset = span.StartOffset;
                        continue;
                    }
                }
            }

            // Paragraph handling
            if (string.IsNullOrWhiteSpace(trimmed))
            {
                if (!inCodeFence)
                {
                    FlushCurrentParagraph();
                }
                else
                {
                    currentParaLines.Add(span);
                }
            }
            else
            {
                currentParaLines.Add(span);
            }
        }

        FlushSection();

        // If no sections were produced (e.g. document with only headings or empty), produce a minimal section
        if (sections.Count == 0 && lineSpans.Count > 0)
        {
            var firstLine = lineSpans[Math.Min(contentStartLineIndex, lineSpans.Count - 1)];
            var lastLine = lineSpans[^1];
            var hash = DocumentModelHelpers.ComputeSectionHash(currentHeadingPath, "");
            sections.Add(new DocumentSection(
                0,
                currentHeading,
                currentHeadingPath,
                firstLine.LineNumber,
                lastLine.LineNumber,
                firstLine.StartOffset,
                lastLine.EndOffset,
                hash,
                ""));
        }

        return sections;
    }

    private static void EmitBoundedSections(
        List<DocumentSection> sections,
        List<ParagraphBlock> paragraphs,
        string heading,
        string headingPath,
        int headingLine,
        int headingOffset)
    {
        var currentBatch = new List<ParagraphBlock>();
        int currentTokens = 0;

        void EmitBatch()
        {
            if (currentBatch.Count == 0) return;
            int sectionIndex = sections.Count;
            string body = string.Join("\n\n", currentBatch.Select(b => b.Text));
            int startLine = (sectionIndex == 0 || headingLine == currentBatch[0].StartLine - 1)
                ? Math.Min(headingLine, currentBatch[0].StartLine)
                : currentBatch[0].StartLine;
            int endLine = currentBatch[^1].EndLine;
            int startOffset = (startLine == headingLine) ? headingOffset : currentBatch[0].StartOffset;
            int endOffset = currentBatch[^1].EndOffset;

            string hash = DocumentModelHelpers.ComputeSectionHash(headingPath, body);
            sections.Add(new DocumentSection(
                sectionIndex,
                heading,
                headingPath,
                startLine,
                endLine,
                startOffset,
                endOffset,
                hash,
                body));
        }

        foreach (var p in paragraphs)
        {
            int pTokens = DocumentModelHelpers.EstimateTokenCount(p.Text);
            if (pTokens > 500)
            {
                if (currentBatch.Count > 0)
                {
                    EmitBatch();
                    currentBatch.Clear();
                    currentTokens = 0;
                }

                // Split oversized paragraph into 100-500 token sub-chunks
                var subBlocks = SplitLargeParagraph(p);
                foreach (var subBlock in subBlocks)
                {
                    currentBatch.Add(subBlock);
                    EmitBatch();
                    currentBatch.Clear();
                }
            }
            else if (currentBatch.Count > 0 && currentTokens + pTokens > 500)
            {
                EmitBatch();
                currentBatch.Clear();
                currentBatch.Add(p);
                currentTokens = pTokens;
            }
            else
            {
                currentBatch.Add(p);
                currentTokens += pTokens;
            }
        }

        if (currentBatch.Count > 0)
        {
            EmitBatch();
        }
    }

    private static List<ParagraphBlock> SplitLargeParagraph(ParagraphBlock block)
    {
        var result = new List<ParagraphBlock>();
        var sentences = Regex.Split(block.Text, @"(?<=[.!?])\s+");
        var currentLines = new List<string>();
        int currentTokens = 0;

        foreach (var sentence in sentences)
        {
            int sTokens = DocumentModelHelpers.EstimateTokenCount(sentence);
            if (currentLines.Count > 0 && currentTokens + sTokens > 500)
            {
                var chunkText = string.Join(" ", currentLines);
                result.Add(new ParagraphBlock(chunkText, block.StartLine, block.EndLine, block.StartOffset, block.EndOffset));
                currentLines.Clear();
                currentTokens = 0;
            }
            currentLines.Add(sentence);
            currentTokens += sTokens;
        }

        if (currentLines.Count > 0)
        {
            var chunkText = string.Join(" ", currentLines);
            result.Add(new ParagraphBlock(chunkText, block.StartLine, block.EndLine, block.StartOffset, block.EndOffset));
        }

        return result.Count > 0 ? result : [block];
    }
}
