using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Praxis.CodeIntelligence.Host;
using Praxis.CodeIntelligence.Indexing;
using Praxis.CodeIntelligence.Indexing.Documents;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class DocumentParserTests
{
    [Fact]
    public void MarkdownChunkerExtractsYamlFrontmatterAndBreadcrumbs()
    {
        var parser = new MarkdownDocumentChunker();
        Assert.True(parser.CanParse("docs/architecture.md"));
        Assert.True(parser.CanParse("notes.txt"));
        Assert.False(parser.CanParse("image.png"));

        var markdown = """
        ---
        title: Architecture Overview
        author: Team Praxis
        tags:
          - search
          - indexing
        ---

        # Introduction

        This is introductory text.

        ## System Components

        Component details paragraph.

        ### Storage Layer

        Storage layer explanation paragraph.
        """;

        var bytes = Encoding.UTF8.GetBytes(markdown);
        var doc = parser.Parse("docs/arch.md", bytes, "/repo");

        Assert.Equal("docs/arch.md", doc.RelativePath);
        Assert.Equal("Architecture Overview", doc.Title);
        Assert.Equal("markdown", doc.DocType);
        Assert.True(doc.Sections.Count >= 3);

        // Check frontmatter JSON
        var fm = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(doc.FrontmatterJson);
        Assert.NotNull(fm);
        Assert.Equal("Architecture Overview", fm["title"].GetString());
        Assert.Equal("Team Praxis", fm["author"].GetString());

        // Check headings & breadcrumbs
        var introSec = doc.Sections[0];
        Assert.Equal("Introduction", introSec.Heading);
        Assert.Equal("Introduction", introSec.HeadingPath);
        Assert.Equal("This is introductory text.", introSec.Body);
        Assert.Equal(
            "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(introSec.HeadingPath + "\n" + introSec.Body))),
            introSec.SectionHash);

        var compSec = doc.Sections[1];
        Assert.Equal("System Components", compSec.Heading);
        Assert.Equal("Introduction > System Components", compSec.HeadingPath);

        var storageSec = doc.Sections[2];
        Assert.Equal("Storage Layer", storageSec.Heading);
        Assert.Equal("Introduction > System Components > Storage Layer", storageSec.HeadingPath);
    }

    [Fact]
    public void MarkdownChunkerExtractsPraxisFrontmatter()
    {
        var parser = new MarkdownDocumentChunker();
        var markdown = """
        **Status:** ✅ Complete
        **Type:** Bug
        id: FX-BG-046
        title: Folder-backed board does not refresh
        status: Done

        # [P2] Folder-backed board does not refresh

        ## Description

        A folder-backed project board does not show external changes.

        ## Work Log

        Fixed the file watcher reconciliation pass.
        """;

        var bytes = Encoding.UTF8.GetBytes(markdown);
        var doc = parser.Parse("plans/bug.md", bytes, "/repo");

        Assert.Equal("Folder-backed board does not refresh", doc.Title);
        var fm = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(doc.FrontmatterJson);
        Assert.NotNull(fm);
        Assert.Equal("✅ Complete", fm["Status"].GetString());
        Assert.Equal("Bug", fm["Type"].GetString());
        Assert.Equal("FX-BG-046", fm["id"].GetString());

        Assert.Equal(2, doc.Sections.Count);
        Assert.Contains("Description", doc.Sections[0].Heading);
        Assert.Contains("Work Log", doc.Sections[1].Heading);
    }

    [Fact]
    public void MarkdownChunkerIgnoresHeadingsInsideCodeBlocks()
    {
        var parser = new MarkdownDocumentChunker();
        var markdown = """
        # Code Examples

        Here is some code:

        ```csharp
        // This is a C# comment
        #if DEBUG
        Console.WriteLine("Debug");
        #endif
        ```

        ## Next Steps

        Done.
        """;

        var bytes = Encoding.UTF8.GetBytes(markdown);
        var doc = parser.Parse("docs/code.md", bytes, "/repo");

        Assert.Equal(2, doc.Sections.Count);
        Assert.Equal("Code Examples", doc.Sections[0].Heading);
        Assert.Contains("#if DEBUG", doc.Sections[0].Body);
        Assert.Equal("Next Steps", doc.Sections[1].Heading);
    }

    [Fact]
    public void MarkdownChunkerSplitsLongSectionsIntoBoundedChunks()
    {
        var parser = new MarkdownDocumentChunker();
        var sb = new StringBuilder();
        sb.AppendLine("# Long Document");

        // Generate 6 paragraphs of 150 words each (~200 tokens each)
        for (int p = 1; p <= 6; p++)
        {
            var words = Enumerable.Range(1, 150).Select(w => $"word{w}").ToArray();
            sb.AppendLine(string.Join(" ", words));
            sb.AppendLine();
        }

        var bytes = Encoding.UTF8.GetBytes(sb.ToString());
        var doc = parser.Parse("docs/long.md", bytes, "/repo");

        // 6 paragraphs of ~200 tokens = ~1200 tokens total -> must be split into multiple bounded sections
        Assert.True(doc.Sections.Count >= 2);
        foreach (var sec in doc.Sections)
        {
            Assert.Equal("Long Document", sec.Heading);
            Assert.Equal("Long Document", sec.HeadingPath);
            Assert.False(string.IsNullOrWhiteSpace(sec.Body));
            Assert.Equal(
                "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sec.HeadingPath + "\n" + sec.Body))),
                sec.SectionHash);
        }
    }

    [Fact]
    public void WordDocumentParserExtractsHeadingsAndTablesFromDocx()
    {
        var docXml = """
        <?xml version="1.0" encoding="utf-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:p>
              <w:pPr>
                <w:pStyle w:val="Heading1"/>
              </w:pPr>
              <w:r><w:t>Project Specification</w:t></w:r>
            </w:p>
            <w:p>
              <w:r><w:t>This is the overview paragraph describing the system.</w:t></w:r>
            </w:p>
            <w:p>
              <w:pPr>
                <w:pStyle w:val="Heading2"/>
              </w:pPr>
              <w:r><w:t>Requirements Table</w:t></w:r>
            </w:p>
            <w:tbl>
              <w:tr>
                <w:tc><w:p><w:r><w:t>Feature</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>Priority</w:t></w:r></w:p></w:tc>
              </w:tr>
              <w:tr>
                <w:tc><w:p><w:r><w:t>Knowledge Base</w:t></w:r></w:p></w:tc>
                <w:tc><w:p><w:r><w:t>P1</w:t></w:r></w:p></w:tc>
              </w:tr>
            </w:tbl>
          </w:body>
        </w:document>
        """;

        var coreXml = """
        <?xml version="1.0" encoding="utf-8"?>
        <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                           xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>Specification v2</dc:title>
        </cp:coreProperties>
        """;

        var bytes = CreateWordDocumentBytes(docXml, coreXml);
        var parser = new WordDocumentParser();
        Assert.True(parser.CanParse("specs/system.docx"));
        Assert.False(parser.CanParse("specs/system.txt"));

        var doc = parser.Parse("specs/system.docx", bytes, "/repo");

        Assert.Equal("specs/system.docx", doc.RelativePath);
        Assert.Equal("Specification v2", doc.Title);
        Assert.Equal("docx", doc.DocType);
        Assert.Equal(2, doc.Sections.Count);

        var sec1 = doc.Sections[0];
        Assert.Equal("Project Specification", sec1.Heading);
        Assert.Contains("This is the overview paragraph", sec1.Body);

        var sec2 = doc.Sections[1];
        Assert.Equal("Requirements Table", sec2.Heading);
        Assert.Equal("Project Specification > Requirements Table", sec2.HeadingPath);
        Assert.Contains("| Feature | Priority |", sec2.Body);
        Assert.Contains("| Knowledge Base | P1 |", sec2.Body);
        Assert.Equal(
            "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sec2.HeadingPath + "\n" + sec2.Body))),
            sec2.SectionHash);
    }

    [Fact]
    public void PresentationDocumentParserExtractsSlideTextFromPptx()
    {
        var slide1Xml = """
        <?xml version="1.0" encoding="utf-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:cSld>
            <p:spTree>
              <p:sp>
                <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
                <p:txBody>
                  <a:p><a:r><a:t>Executive Summary</a:t></a:r></a:p>
                </p:txBody>
              </p:sp>
              <p:sp>
                <p:txBody>
                  <a:p><a:r><a:t>Key findings and next milestones.</a:t></a:r></a:p>
                </p:txBody>
              </p:sp>
            </p:spTree>
          </p:cSld>
        </p:sld>
        """;

        var slide2Xml = """
        <?xml version="1.0" encoding="utf-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:cSld>
            <p:spTree>
              <p:sp>
                <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
                <p:txBody>
                  <a:p><a:r><a:t>Architecture Diagram</a:t></a:r></a:p>
                </p:txBody>
              </p:sp>
              <p:sp>
                <p:txBody>
                  <a:p><a:r><a:t>Microservices and local ONNX runtime.</a:t></a:r></a:p>
                </p:txBody>
              </p:sp>
            </p:spTree>
          </p:cSld>
        </p:sld>
        """;

        var coreXml = """
        <?xml version="1.0" encoding="utf-8"?>
        <cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                           xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>Q3 Strategy Deck</dc:title>
        </cp:coreProperties>
        """;

        var bytes = CreatePresentationBytes([slide1Xml, slide2Xml], coreXml);
        var parser = new PresentationDocumentParser();
        Assert.True(parser.CanParse("decks/strategy.pptx"));
        Assert.False(parser.CanParse("decks/strategy.pdf"));

        var doc = parser.Parse("decks/strategy.pptx", bytes, "/repo");

        Assert.Equal("decks/strategy.pptx", doc.RelativePath);
        Assert.Equal("Q3 Strategy Deck", doc.Title);
        Assert.Equal("pptx", doc.DocType);
        Assert.Equal(2, doc.Sections.Count);

        Assert.Equal("Executive Summary", doc.Sections[0].Heading);
        Assert.Equal("Slide 1: Executive Summary", doc.Sections[0].HeadingPath);
        Assert.Contains("Key findings and next milestones.", doc.Sections[0].Body);

        Assert.Equal("Architecture Diagram", doc.Sections[1].Heading);
        Assert.Equal("Slide 2: Architecture Diagram", doc.Sections[1].HeadingPath);
        Assert.Contains("Microservices and local ONNX runtime.", doc.Sections[1].Body);
    }

    [Fact]
    public void CsvDocumentParserExtractsHeadersAndBatchesRows()
    {
        var csv = """
        ID,Name,Role,City
        1,Alice,Engineer,London
        2,Bob,Designer,Paris
        3,Charlie,"Product Manager",Berlin
        """;

        var bytes = Encoding.UTF8.GetBytes(csv);
        var parser = new CsvDocumentParser();
        Assert.True(parser.CanParse("data/team.csv"));
        Assert.False(parser.CanParse("data/team.tsv"));

        var doc = parser.Parse("data/team.csv", bytes, "/repo");

        Assert.Equal("data/team.csv", doc.RelativePath);
        Assert.Equal("team", doc.Title);
        Assert.Equal("csv", doc.DocType);

        var fm = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(doc.FrontmatterJson);
        Assert.NotNull(fm);
        Assert.Equal(3, fm["totalRows"].GetInt32());
        Assert.Equal(4, fm["totalColumns"].GetInt32());

        Assert.Single(doc.Sections);
        var sec = doc.Sections[0];
        Assert.Equal("Rows 1-3", sec.Heading);
        Assert.Equal("team > Rows 1-3", sec.HeadingPath);
        Assert.Contains("| ID | Name | Role | City |", sec.Body);
        Assert.Contains("| 1 | Alice | Engineer | London |", sec.Body);
        Assert.Contains("| 3 | Charlie | Product Manager | Berlin |", sec.Body);
        Assert.Equal(
            "sha256:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sec.HeadingPath + "\n" + sec.Body))),
            sec.SectionHash);
    }

    [Fact]
    public void SourceScannerAndRepositoryMonitorClassifyDocumentFiles()
    {
        Assert.True(SourceScanner.IsSearchableDocumentFile("docs/readme.md"));
        Assert.True(SourceScanner.IsSearchableDocumentFile("specs/requirements.docx"));
        Assert.True(SourceScanner.IsSearchableDocumentFile("decks/presentation.pptx"));
        Assert.True(SourceScanner.IsSearchableDocumentFile("data/export.csv"));
        Assert.True(SourceScanner.IsSearchableDocumentFile("notes.txt"));
        Assert.True(SourceScanner.IsSearchableDocumentFile("config/settings.json"));

        Assert.False(SourceScanner.IsSearchableDocumentFile("package-lock.json"));
        Assert.False(SourceScanner.IsSearchableDocumentFile("packages.lock.json"));
        Assert.False(SourceScanner.IsSearchableDocumentFile("bundle.lock.json"));
        Assert.False(SourceScanner.IsSearchableDocumentFile("Program.cs"));
        Assert.False(SourceScanner.IsSearchableDocumentFile("app.ts"));

        // Binary files allow up to 25 MiB
        Assert.Equal(25L * 1024 * 1024, SourceScanner.MaximumBinaryDocumentBytes);
    }

    private static byte[] CreateWordDocumentBytes(string documentXml, string? coreXml = null)
    {
        using var ms = new MemoryStream();
        using (var archive = new ZipArchive(ms, ZipArchiveMode.Create, true))
        {
            var docEntry = archive.CreateEntry("word/document.xml");
            using (var writer = new StreamWriter(docEntry.Open(), Encoding.UTF8))
            {
                writer.Write(documentXml);
            }
            if (coreXml is not null)
            {
                var coreEntry = archive.CreateEntry("docProps/core.xml");
                using var writer = new StreamWriter(coreEntry.Open(), Encoding.UTF8);
                writer.Write(coreXml);
            }
        }
        return ms.ToArray();
    }

    private static byte[] CreatePresentationBytes(IReadOnlyList<string> slideXmls, string? coreXml = null)
    {
        using var ms = new MemoryStream();
        using (var archive = new ZipArchive(ms, ZipArchiveMode.Create, true))
        {
            for (int i = 0; i < slideXmls.Count; i++)
            {
                var slideEntry = archive.CreateEntry($"ppt/slides/slide{i + 1}.xml");
                using var writer = new StreamWriter(slideEntry.Open(), Encoding.UTF8);
                writer.Write(slideXmls[i]);
            }
            if (coreXml is not null)
            {
                var coreEntry = archive.CreateEntry("docProps/core.xml");
                using var writer = new StreamWriter(coreEntry.Open(), Encoding.UTF8);
                writer.Write(coreXml);
            }
        }
        return ms.ToArray();
    }
}
