using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace Praxis.CodeIntelligence.Indexing.Documents;

public sealed class WordDocumentParser : IDocumentParser
{
    private sealed record BlockItem(string Text, bool IsTable);

    public bool CanParse(string relativePath) =>
        relativePath.EndsWith(".docx", StringComparison.OrdinalIgnoreCase);

    public ParsedDocument Parse(string relativePath, byte[] bytes, string root)
    {
        var pathKey = DocumentModelHelpers.ToPathKey(relativePath);
        var contentHash = SourceFiles.Hash(bytes);

        using var memoryStream = new MemoryStream(bytes);
        using var archive = new ZipArchive(memoryStream, ZipArchiveMode.Read);

        string? coreTitle = ExtractCoreTitle(archive);
        var docEntry = archive.GetEntry("word/document.xml")
            ?? throw new InvalidDataException("Invalid Word document: word/document.xml not found.");

        using var docStream = docEntry.Open();
        var (sections, firstHeading) = ParseDocumentXml(docStream, coreTitle, relativePath);

        string title = !string.IsNullOrWhiteSpace(coreTitle)
            ? coreTitle
            : (!string.IsNullOrWhiteSpace(firstHeading) ? firstHeading : Path.GetFileNameWithoutExtension(relativePath));

        return new ParsedDocument(
            relativePath,
            pathKey,
            contentHash,
            "docx",
            title,
            "{}",
            bytes.Length,
            sections);
    }

    private static string? ExtractCoreTitle(ZipArchive archive)
    {
        var coreEntry = archive.GetEntry("docProps/core.xml");
        if (coreEntry is null) return null;

        try
        {
            using var stream = coreEntry.Open();
            using var reader = XmlReader.Create(stream, new XmlReaderSettings { IgnoreWhitespace = true });
            while (reader.Read())
            {
                if (reader.NodeType == XmlNodeType.Element && reader.LocalName == "title")
                {
                    var text = reader.ReadElementContentAsString().Trim();
                    if (!string.IsNullOrEmpty(text)) return text;
                }
            }
        }
        catch
        {
            // Ignore corrupted metadata
        }
        return null;
    }

    private static (IReadOnlyList<DocumentSection> Sections, string? FirstHeading) ParseDocumentXml(
        Stream stream,
        string? defaultTitle,
        string relativePath)
    {
        var sections = new List<DocumentSection>();
        var headingStack = new List<(int Level, string Heading)>();
        string? firstHeading = null;

        string currentHeading = defaultTitle ?? Path.GetFileNameWithoutExtension(relativePath);
        string currentHeadingPath = currentHeading;

        var currentBlocks = new List<BlockItem>();
        int currentLine = 1;
        int currentOffset = 0;

        void FlushSection()
        {
            if (currentBlocks.Count == 0) return;

            var body = string.Join("\n\n", currentBlocks.Select(b => b.Text));
            var bodyTokens = DocumentModelHelpers.EstimateTokenCount(body);

            if (bodyTokens > 500 && currentBlocks.Count > 1)
            {
                var chunkBlocks = new List<BlockItem>();
                int chunkTokens = 0;
                foreach (var block in currentBlocks)
                {
                    int bTokens = DocumentModelHelpers.EstimateTokenCount(block.Text);
                    if (chunkBlocks.Count > 0 && chunkTokens + bTokens > 500)
                    {
                        EmitSection(chunkBlocks);
                        chunkBlocks.Clear();
                        chunkTokens = 0;
                    }
                    chunkBlocks.Add(block);
                    chunkTokens += bTokens;
                }
                if (chunkBlocks.Count > 0)
                {
                    EmitSection(chunkBlocks);
                }
            }
            else
            {
                EmitSection(currentBlocks);
            }

            currentBlocks.Clear();
        }

        void EmitSection(IReadOnlyList<BlockItem> blocks)
        {
            int sectionIndex = sections.Count;
            string sectionBody = string.Join("\n\n", blocks.Select(b => b.Text));
            string hash = DocumentModelHelpers.ComputeSectionHash(currentHeadingPath, sectionBody);

            int startLine = currentLine;
            int lineCount = sectionBody.Count(c => c == '\n') + 1;
            int endLine = currentLine + lineCount - 1;
            int startOffset = currentOffset;
            int endOffset = currentOffset + sectionBody.Length;

            sections.Add(new DocumentSection(
                sectionIndex,
                currentHeading,
                currentHeadingPath,
                startLine,
                endLine,
                startOffset,
                endOffset,
                hash,
                sectionBody));

            currentLine = endLine + 1;
            currentOffset = endOffset + 2;
        }

        using var reader = XmlReader.Create(stream, new XmlReaderSettings
        {
            IgnoreWhitespace = true,
            DtdProcessing = DtdProcessing.Prohibit
        });

        while (reader.Read())
        {
            if (reader.NodeType != XmlNodeType.Element) continue;

            if (reader.LocalName == "p")
            {
                using var pSubReader = reader.ReadSubtree();
                var (style, outlineLvl, text) = ParseParagraph(pSubReader);

                if (string.IsNullOrWhiteSpace(text)) continue;

                var headingLevel = DetectHeadingLevel(style, outlineLvl);
                if (headingLevel.HasValue)
                {
                    FlushSection();

                    firstHeading ??= text;

                    while (headingStack.Count > 0 && headingStack[^1].Level >= headingLevel.Value)
                    {
                        headingStack.RemoveAt(headingStack.Count - 1);
                    }
                    headingStack.Add((headingLevel.Value, text));

                    currentHeading = text;
                    currentHeadingPath = string.Join(" > ", headingStack.Select(h => h.Heading));
                }
                else
                {
                    currentBlocks.Add(new BlockItem(text, false));
                }
            }
            else if (reader.LocalName == "tbl")
            {
                using var tblSubReader = reader.ReadSubtree();
                var tableMarkdown = ParseTable(tblSubReader);
                if (!string.IsNullOrWhiteSpace(tableMarkdown))
                {
                    currentBlocks.Add(new BlockItem(tableMarkdown, true));
                }
            }
        }

        FlushSection();

        if (sections.Count == 0)
        {
            var hash = DocumentModelHelpers.ComputeSectionHash(currentHeadingPath, "");
            sections.Add(new DocumentSection(0, currentHeading, currentHeadingPath, 1, 1, 0, 0, hash, ""));
        }

        return (sections, firstHeading);
    }

    private static (string? Style, int? OutlineLvl, string Text) ParseParagraph(XmlReader reader)
    {
        string? style = null;
        int? outlineLvl = null;
        var sb = new StringBuilder();

        while (reader.Read())
        {
            if (reader.NodeType != XmlNodeType.Element) continue;

            var name = reader.LocalName;
            if (name == "pStyle")
            {
                style = reader.GetAttribute("w:val") ?? reader.GetAttribute("val");
            }
            else if (name == "outlineLvl")
            {
                var lvlStr = reader.GetAttribute("w:val") ?? reader.GetAttribute("val");
                if (int.TryParse(lvlStr, out var lvl)) outlineLvl = lvl;
            }
            else if (name == "t")
            {
                sb.Append(reader.ReadElementContentAsString());
            }
            else if (name == "tab")
            {
                sb.Append('\t');
            }
            else if (name == "br")
            {
                sb.Append('\n');
            }
        }

        return (style, outlineLvl, sb.ToString().Trim());
    }

    private static string ParseTable(XmlReader reader)
    {
        var rows = new List<List<string>>();
        List<string>? currentRow = null;
        StringBuilder? currentCell = null;

        while (reader.Read())
        {
            if (reader.NodeType == XmlNodeType.Element)
            {
                if (reader.LocalName == "tr")
                {
                    currentRow = new List<string>();
                    rows.Add(currentRow);
                }
                else if (reader.LocalName == "tc")
                {
                    currentCell = new StringBuilder();
                }
                else if (reader.LocalName == "t" && currentCell is not null)
                {
                    currentCell.Append(reader.ReadElementContentAsString());
                }
                else if (reader.LocalName == "tab" && currentCell is not null)
                {
                    currentCell.Append(' ');
                }
                else if (reader.LocalName == "br" && currentCell is not null)
                {
                    currentCell.Append(' ');
                }
            }
            else if (reader.NodeType == XmlNodeType.EndElement)
            {
                if (reader.LocalName == "tc" && currentCell is not null && currentRow is not null)
                {
                    currentRow.Add(currentCell.ToString().Trim());
                    currentCell = null;
                }
            }
        }

        if (rows.Count == 0) return "";

        int colCount = rows.Max(r => r.Count);
        if (colCount == 0) return "";

        var sb = new StringBuilder();
        for (int r = 0; r < rows.Count; r++)
        {
            var row = rows[r];
            while (row.Count < colCount) row.Add("");

            sb.Append("| ").Append(string.Join(" | ", row.Select(c => c.Replace('|', '/')))).AppendLine(" |");
            if (r == 0)
            {
                sb.Append("| ").Append(string.Join(" | ", Enumerable.Repeat("---", colCount))).AppendLine(" |");
            }
        }

        return sb.ToString().TrimEnd();
    }

    private static int? DetectHeadingLevel(string? style, int? outlineLvl)
    {
        if (outlineLvl.HasValue && outlineLvl.Value >= 0 && outlineLvl.Value <= 8)
            return outlineLvl.Value + 1;

        if (string.IsNullOrWhiteSpace(style)) return null;

        var normalized = style.ToLowerInvariant().Replace(" ", "").Replace("_", "");
        if (normalized is "title") return 1;
        if (normalized is "subtitle") return 2;

        var match = Regex.Match(normalized, @"^heading([1-9])$");
        if (match.Success)
            return int.Parse(match.Groups[1].Value);

        return null;
    }
}
