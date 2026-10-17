using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace Praxis.CodeIntelligence.Indexing.Documents;

public sealed class PresentationDocumentParser : IDocumentParser
{
    private sealed record SlideInfo(int SlideNumber, string Title, IReadOnlyList<string> BodyParagraphs);

    public bool CanParse(string relativePath) =>
        relativePath.EndsWith(".pptx", StringComparison.OrdinalIgnoreCase);

    public ParsedDocument Parse(string relativePath, byte[] bytes, string root)
    {
        var pathKey = DocumentModelHelpers.ToPathKey(relativePath);
        var contentHash = SourceFiles.Hash(bytes);

        using var memoryStream = new MemoryStream(bytes);
        using var archive = new ZipArchive(memoryStream, ZipArchiveMode.Read);

        string? coreTitle = ExtractCoreTitle(archive);

        var slideEntries = archive.Entries
            .Where(e => Regex.IsMatch(e.FullName, @"^ppt/slides/slide\d+\.xml$"))
            .OrderBy(e =>
            {
                var match = Regex.Match(e.FullName, @"slide(\d+)\.xml");
                return match.Success ? int.Parse(match.Groups[1].Value) : 0;
            })
            .ToList();

        var slides = new List<SlideInfo>();
        for (int i = 0; i < slideEntries.Count; i++)
        {
            using var slideStream = slideEntries[i].Open();
            var slide = ParseSlideXml(slideStream, i + 1);
            slides.Add(slide);
        }

        string title = !string.IsNullOrWhiteSpace(coreTitle)
            ? coreTitle
            : (slides.FirstOrDefault(s => !string.IsNullOrWhiteSpace(s.Title))?.Title ?? Path.GetFileNameWithoutExtension(relativePath));

        var sections = new List<DocumentSection>();
        int currentOffset = 0;

        foreach (var slide in slides)
        {
            var heading = !string.IsNullOrWhiteSpace(slide.Title) ? slide.Title : $"Slide {slide.SlideNumber}";
            var headingPath = !string.IsNullOrWhiteSpace(slide.Title)
                ? $"Slide {slide.SlideNumber}: {slide.Title}"
                : $"Slide {slide.SlideNumber}";

            var fullSlideBody = string.Join("\n\n", slide.BodyParagraphs);
            if (string.IsNullOrWhiteSpace(fullSlideBody))
            {
                fullSlideBody = heading;
            }

            var tokens = DocumentModelHelpers.EstimateTokenCount(fullSlideBody);
            if (tokens > 500 && slide.BodyParagraphs.Count > 1)
            {
                var currentBatch = new List<string>();
                int currentTokens = 0;
                foreach (var p in slide.BodyParagraphs)
                {
                    int pTokens = DocumentModelHelpers.EstimateTokenCount(p);
                    if (currentBatch.Count > 0 && currentTokens + pTokens > 500)
                    {
                        EmitSlideSection(sections, heading, headingPath, slide.SlideNumber, string.Join("\n\n", currentBatch), ref currentOffset);
                        currentBatch.Clear();
                        currentTokens = 0;
                    }
                    currentBatch.Add(p);
                    currentTokens += pTokens;
                }
                if (currentBatch.Count > 0)
                {
                    EmitSlideSection(sections, heading, headingPath, slide.SlideNumber, string.Join("\n\n", currentBatch), ref currentOffset);
                }
            }
            else
            {
                EmitSlideSection(sections, heading, headingPath, slide.SlideNumber, fullSlideBody, ref currentOffset);
            }
        }

        if (sections.Count == 0)
        {
            var hash = DocumentModelHelpers.ComputeSectionHash(title, "");
            sections.Add(new DocumentSection(0, title, title, 1, 1, 0, 0, hash, ""));
        }

        return new ParsedDocument(
            relativePath,
            pathKey,
            contentHash,
            "pptx",
            title,
            "{}",
            bytes.Length,
            sections);
    }

    private static void EmitSlideSection(
        List<DocumentSection> sections,
        string heading,
        string headingPath,
        int slideNumber,
        string body,
        ref int currentOffset)
    {
        int index = sections.Count;
        string hash = DocumentModelHelpers.ComputeSectionHash(headingPath, body);
        int startOffset = currentOffset;
        int endOffset = currentOffset + body.Length;

        sections.Add(new DocumentSection(
            index,
            heading,
            headingPath,
            slideNumber,
            slideNumber,
            startOffset,
            endOffset,
            hash,
            body));

        currentOffset = endOffset + 2;
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

    private static SlideInfo ParseSlideXml(Stream stream, int slideNumber)
    {
        string? title = null;
        var paragraphs = new List<string>();

        using var reader = XmlReader.Create(stream, new XmlReaderSettings
        {
            IgnoreWhitespace = true,
            DtdProcessing = DtdProcessing.Prohibit
        });

        while (reader.Read())
        {
            if (reader.NodeType != XmlNodeType.Element) continue;

            if (reader.LocalName == "sp")
            {
                using var spReader = reader.ReadSubtree();
                var (isTitle, shapeParagraphs) = ParseShape(spReader);
                if (shapeParagraphs.Count > 0)
                {
                    if (isTitle && title is null)
                    {
                        title = shapeParagraphs[0];
                        paragraphs.AddRange(shapeParagraphs.Skip(1));
                    }
                    else
                    {
                        paragraphs.AddRange(shapeParagraphs);
                    }
                }
            }
        }

        if (title is null && paragraphs.Count > 0)
        {
            title = paragraphs[0];
            paragraphs.RemoveAt(0);
        }

        return new SlideInfo(slideNumber, title ?? "", paragraphs);
    }

    private static (bool IsTitle, List<string> Paragraphs) ParseShape(XmlReader reader)
    {
        bool isTitle = false;
        var paragraphs = new List<string>();
        var currentPara = new StringBuilder();

        while (reader.Read())
        {
            if (reader.NodeType == XmlNodeType.Element)
            {
                if (reader.LocalName == "ph")
                {
                    var phType = reader.GetAttribute("type");
                    if (phType is "title" or "ctrTitle") isTitle = true;
                }
                else if (reader.LocalName == "p")
                {
                    if (currentPara.Length > 0)
                    {
                        var t = currentPara.ToString().Trim();
                        if (!string.IsNullOrEmpty(t)) paragraphs.Add(t);
                        currentPara.Clear();
                    }
                }
                else if (reader.LocalName == "t")
                {
                    currentPara.Append(reader.ReadElementContentAsString());
                }
            }
            else if (reader.NodeType == XmlNodeType.EndElement && reader.LocalName == "p")
            {
                if (currentPara.Length > 0)
                {
                    var t = currentPara.ToString().Trim();
                    if (!string.IsNullOrEmpty(t)) paragraphs.Add(t);
                    currentPara.Clear();
                }
            }
        }

        if (currentPara.Length > 0)
        {
            var t = currentPara.ToString().Trim();
            if (!string.IsNullOrEmpty(t)) paragraphs.Add(t);
        }

        return (isTitle, paragraphs);
    }
}
