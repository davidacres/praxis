using System.Text;
using System.Text.Json;

namespace Praxis.CodeIntelligence.Indexing.Documents;

public sealed class CsvDocumentParser : IDocumentParser
{
    private sealed record RowSpan(int LineNumber, int StartOffset, int EndOffset, List<string> Cells);

    public bool CanParse(string relativePath) =>
        relativePath.EndsWith(".csv", StringComparison.OrdinalIgnoreCase);

    public ParsedDocument Parse(string relativePath, byte[] bytes, string root)
    {
        var text = SourceFiles.Decode(bytes);
        var pathKey = DocumentModelHelpers.ToPathKey(relativePath);
        var contentHash = SourceFiles.Hash(bytes);
        var title = Path.GetFileNameWithoutExtension(relativePath);

        var (headers, rows, headerLine, headerEndOffset) = ParseCsv(text);

        var frontmatter = new Dictionary<string, object>
        {
            ["headers"] = headers,
            ["totalColumns"] = headers.Count,
            ["totalRows"] = rows.Count
        };
        var frontmatterJson = JsonSerializer.Serialize(frontmatter);

        var sections = new List<DocumentSection>();
        if (rows.Count == 0)
        {
            var emptyBody = headers.Count > 0 ? FormatTable(headers, []) : "";
            var hash = DocumentModelHelpers.ComputeSectionHash(title, emptyBody);
            sections.Add(new DocumentSection(
                0,
                title,
                title,
                1,
                Math.Max(1, headerLine),
                0,
                headerEndOffset,
                hash,
                emptyBody));
        }
        else
        {
            var currentBatch = new List<RowSpan>();
            int currentTokens = DocumentModelHelpers.EstimateTokenCount(FormatTable(headers, []));

            void EmitBatch()
            {
                if (currentBatch.Count == 0) return;

                int sectionIndex = sections.Count;
                int startRow = currentBatch[0].LineNumber - 1; // 1-based data row index
                int endRow = currentBatch[^1].LineNumber - 1;
                string heading = $"Rows {startRow}-{endRow}";
                string headingPath = $"{title} > Rows {startRow}-{endRow}";

                string body = FormatTable(headers, currentBatch.Select(r => r.Cells).ToList());
                string hash = DocumentModelHelpers.ComputeSectionHash(headingPath, body);

                int startLine = currentBatch[0].LineNumber;
                int endLine = currentBatch[^1].LineNumber;
                int startOffset = currentBatch[0].StartOffset;
                int endOffset = currentBatch[^1].EndOffset;

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

            foreach (var row in rows)
            {
                int rowTokens = DocumentModelHelpers.EstimateTokenCount(string.Join(" ", row.Cells));
                if (currentBatch.Count > 0 && (currentTokens + rowTokens > 450 || currentBatch.Count >= 50))
                {
                    EmitBatch();
                    currentBatch.Clear();
                    currentTokens = DocumentModelHelpers.EstimateTokenCount(FormatTable(headers, []));
                }

                currentBatch.Add(row);
                currentTokens += rowTokens;
            }

            if (currentBatch.Count > 0)
            {
                EmitBatch();
            }
        }

        return new ParsedDocument(
            relativePath,
            pathKey,
            contentHash,
            "csv",
            title,
            frontmatterJson,
            bytes.Length,
            sections);
    }

    private static (List<string> Headers, List<RowSpan> Rows, int HeaderLine, int HeaderEndOffset) ParseCsv(string text)
    {
        var rawRows = new List<(int LineNumber, int StartOffset, int EndOffset, List<string> Cells)>();
        int lineNum = 1;

        int i = 0;
        while (i < text.Length)
        {
            int rowStartOffset = i;
            var cells = new List<string>();
            var cellBuilder = new StringBuilder();
            bool inQuotes = false;
            int rowStartLine = lineNum;

            while (i < text.Length)
            {
                char c = text[i];
                if (c == '"')
                {
                    if (inQuotes && i + 1 < text.Length && text[i + 1] == '"')
                    {
                        cellBuilder.Append('"');
                        i += 2;
                        continue;
                    }
                    inQuotes = !inQuotes;
                    i++;
                }
                else if (c == ',' && !inQuotes)
                {
                    cells.Add(cellBuilder.ToString().Trim());
                    cellBuilder.Clear();
                    i++;
                }
                else if (c == '\r')
                {
                    if (inQuotes)
                    {
                        cellBuilder.Append(c);
                        i++;
                    }
                    else
                    {
                        if (i + 1 < text.Length && text[i + 1] == '\n') i++;
                        i++;
                        lineNum++;
                        break;
                    }
                }
                else if (c == '\n')
                {
                    if (inQuotes)
                    {
                        cellBuilder.Append(c);
                        i++;
                    }
                    else
                    {
                        i++;
                        lineNum++;
                        break;
                    }
                }
                else
                {
                    cellBuilder.Append(c);
                    i++;
                }
            }

            cells.Add(cellBuilder.ToString().Trim());
            int rowEndOffset = i;

            if (cells.Any(c => !string.IsNullOrEmpty(c)))
            {
                rawRows.Add((rowStartLine, rowStartOffset, rowEndOffset, cells));
            }
        }

        if (rawRows.Count == 0)
        {
            return ([], [], 1, 0);
        }

        var headerRow = rawRows[0];
        var headers = headerRow.Cells;
        var dataRows = rawRows.Skip(1).Select(r => new RowSpan(r.LineNumber, r.StartOffset, r.EndOffset, r.Cells)).ToList();

        return (headers, dataRows, headerRow.LineNumber, headerRow.EndOffset);
    }

    private static string FormatTable(IReadOnlyList<string> headers, IReadOnlyList<List<string>> rows)
    {
        int colCount = Math.Max(headers.Count, rows.Count > 0 ? rows.Max(r => r.Count) : 0);
        if (colCount == 0) return "";

        var sb = new StringBuilder();

        var paddedHeaders = headers.ToList();
        while (paddedHeaders.Count < colCount) paddedHeaders.Add($"Col{paddedHeaders.Count + 1}");

        sb.Append("| ").Append(string.Join(" | ", paddedHeaders.Select(h => h.Replace('|', '/')))).AppendLine(" |");
        sb.Append("| ").Append(string.Join(" | ", Enumerable.Repeat("---", colCount))).AppendLine(" |");

        foreach (var row in rows)
        {
            var padded = row.ToList();
            while (padded.Count < colCount) padded.Add("");
            sb.Append("| ").Append(string.Join(" | ", padded.Select(c => c.Replace('|', '/')))).AppendLine(" |");
        }

        return sb.ToString().TrimEnd();
    }
}
