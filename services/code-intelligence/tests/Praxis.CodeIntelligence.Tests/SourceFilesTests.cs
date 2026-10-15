using System.Text;
using System.Runtime.InteropServices;
using Praxis.CodeIntelligence.Indexing;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class SourceFilesTests : IDisposable
{
    [DllImport("libc", EntryPoint = "mkfifo", SetLastError = true)]
    private static extern int MakeFifo([MarshalAs(UnmanagedType.LPUTF8Str)] string path, uint mode);
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

    [Fact]
    public void RenamedOpenedFileIsRejectedEvenWhenTheOriginalPathIsReplaced()
    {
        var path = System.IO.Path.Combine(root, "Example.cs");
        File.WriteAllText(path, "class Original {}");
        using var stream = SafeSourceHandle.Read(root, "Example.cs", path);
        File.Move(path, System.IO.Path.Combine(root, "Moved.cs"));
        File.WriteAllText(path, "class Replacement {}");
        Assert.Throws<IOException>(() => SafeSourceHandle.Verify(stream, path));
        Assert.Equal("class Replacement {}", SourceFiles.Read(root, "Example.cs").Text);
    }

    [Fact]
    public async Task FifoSourceCannotBlockTheIndexerWaitingForAWriter()
    {
        if (OperatingSystem.IsWindows()) return; // Windows has no filesystem FIFO inputs.
        var path = System.IO.Path.Combine(root, "Pipe.cs");
        Assert.Equal(0, MakeFifo(path, 0x180));
        await Task.Run(() => Assert.Throws<IOException>(() => SourceFiles.Read(root, "Pipe.cs"))).WaitAsync(TimeSpan.FromSeconds(3));
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}
