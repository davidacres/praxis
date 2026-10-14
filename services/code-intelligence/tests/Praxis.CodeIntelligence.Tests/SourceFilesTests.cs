using System.Text;
using Praxis.CodeIntelligence.Indexing;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class SourceFilesTests : IDisposable
{
    private readonly string root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "praxis-source-tests-" + Guid.NewGuid().ToString("N"));
    public SourceFilesTests() => Directory.CreateDirectory(root);

    [Fact]
    public void RawBytesDetermineHashWhileUtf16CoordinatesPreserveAstralCharacters()
    {
        const string text = "// 😀\r\nclass Example {}";
        var bytes = Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes(text)).ToArray();
        File.WriteAllBytes(System.IO.Path.Combine(root, "Example.cs"), bytes);
        var source = SourceFiles.Read(root, "Example.cs");
        Assert.Equal(text, source.Text); Assert.Equal(bytes, source.Bytes);
        Assert.Equal(SourceFiles.Hash(bytes), source.Hash);
        Assert.NotEqual(SourceFiles.Hash(Encoding.UTF8.GetBytes(text)), source.Hash);
        Assert.Equal(2, source.Text.AsSpan(3, 2).Length);
    }

    [Theory]
    [InlineData("../outside.cs")]
    [InlineData("a/../../outside.cs")]
    [InlineData("/outside.cs")]
    [InlineData("a\\outside.cs")]
    [InlineData("a//outside.cs")]
    [InlineData("C:/outside.cs")]
    public void TraversalAndAmbiguousPathsAreRejected(string path) => Assert.Throws<ArgumentException>(() => SourceFiles.Read(root, path));

    [Fact]
    public void InvalidEncodingAndOversizedSourcesAreRejected()
    {
        Assert.Throws<DecoderFallbackException>(() => SourceFiles.Decode(new byte[] { 0xff }));
        Assert.Throws<DecoderFallbackException>(() => SourceFiles.Decode(new byte[] { 0xff, 0xfe, 0x00, 0x00 }));
        File.WriteAllBytes(System.IO.Path.Combine(root, "large.cs"), new byte[SourceFiles.MaximumBytes + 1]);
        Assert.Throws<IOException>(() => SourceFiles.Read(root, "large.cs"));
    }

    [Fact]
    public void RootAliasesResolveButSourceAliasesAreExcluded()
    {
        if (OperatingSystem.IsWindows()) return; // Windows link privileges require the platform release fixture.
        var physical = System.IO.Path.Combine(root, "physical"); Directory.CreateDirectory(physical);
        File.WriteAllText(System.IO.Path.Combine(physical, "Example.cs"), "class Example {}");
        var alias = System.IO.Path.Combine(root, "alias"); Directory.CreateSymbolicLink(alias, physical);
        Assert.Equal(SourceFiles.CanonicalDirectory(physical), SourceFiles.CanonicalDirectory(alias));
        Assert.Equal("class Example {}", SourceFiles.Read(alias, "Example.cs").Text);
        File.CreateSymbolicLink(System.IO.Path.Combine(physical, "linked.cs"), System.IO.Path.Combine(physical, "Example.cs"));
        Assert.Throws<IOException>(() => SourceFiles.Read(physical, "linked.cs"));
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}
