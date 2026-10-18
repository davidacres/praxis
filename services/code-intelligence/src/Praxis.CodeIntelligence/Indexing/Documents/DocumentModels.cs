using System.Security.Cryptography;
using System.Text;

namespace Praxis.CodeIntelligence.Indexing.Documents;

public sealed record DocumentSection(
    int SectionIndex,
    string Heading,
    string HeadingPath,
    int StartLine,
    int EndLine,
    int StartOffset,
    int EndOffset,
    string SectionHash,
    string Body);

public sealed record ParsedDocument(
    string RelativePath,
    string PathKey,
    string ContentHash,
    string DocType,
    string Title,
    string FrontmatterJson,
    long SizeBytes,
    IReadOnlyList<DocumentSection> Sections);

public interface IDocumentParser
{
    bool CanParse(string relativePath);
    ParsedDocument Parse(string relativePath, byte[] bytes, string root);
}

public static class DocumentModelHelpers
{
    public static string ToPathKey(string relativePath) =>
        OperatingSystem.IsWindows() ? relativePath.ToUpperInvariant() : relativePath;

    // The service's one hash format ("sha256:" + hex), which the published contract requires.
    public static string ComputeSectionHash(string headingPath, string body) =>
        SourceFiles.Hash(Encoding.UTF8.GetBytes(headingPath + "\n" + body));

    public static int EstimateTokenCount(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return 0;
        int words = 0;
        bool inWord = false;
        for (int i = 0; i < text.Length; i++)
        {
            if (char.IsWhiteSpace(text[i]))
            {
                inWord = false;
            }
            else if (!inWord)
            {
                inWord = true;
                words++;
            }
        }
        return Math.Max((int)Math.Ceiling(words * 1.3), (int)Math.Ceiling(text.Length / 4.0));
    }
}
