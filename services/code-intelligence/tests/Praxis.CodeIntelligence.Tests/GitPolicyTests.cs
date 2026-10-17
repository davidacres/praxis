using System.Diagnostics;
using Praxis.CodeIntelligence.Indexing;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class GitPolicyTests
{
    [Fact]
    public void IgnoredSourcesAreFilteredBeforeDecodingAndFsmonitorCannotExecute()
    {
        var root = Path.Combine(Path.GetTempPath(), "praxis-ignore-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            Git(root, "init"); Git(root, "config", "core.fsmonitor", "!touch should-not-exist");
            Directory.CreateDirectory(Path.Combine(root, "private"));
            File.WriteAllText(Path.Combine(root, ".gitignore"), "private/\nIgnored.cs\n");
            File.WriteAllBytes(Path.Combine(root, "private", "Secret.cs"), [0xff]); File.WriteAllBytes(Path.Combine(root, "Ignored.cs"), [0xff]);
            File.WriteAllText(Path.Combine(root, "Public.cs"), "class Public {}");
            var source = Assert.Single(SourceScanner.Scan(root, [], CancellationToken.None)); Assert.Equal("Public.cs", source.Path);
            Assert.False(File.Exists(Path.Combine(root, "should-not-exist")));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private static void Git(string root, params string[] arguments)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = root, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(15_000);
        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            Assert.True(process.WaitForExit(5000), "Timed-out fixture Git process did not exit after kill.");
        }
        // A loaded Windows runner can take seconds to close the pipes after exit.
        Assert.True(Task.WaitAll([output, error], 15_000), "Fixture Git output did not drain.");
        Assert.True(exited, "Fixture Git setup exceeded 15 seconds.");
        Assert.Equal(0, process.ExitCode);
    }

    [Fact]
    public void ARootInsideARepositoryHonoursItsIgnoreRulesAndSkipsOversizedSources()
    {
        // The desktop registers folders such as apps/web; a built bundle there is ignored by
        // the repository's .gitignore and is also over the 2 MiB source limit.
        var repository = Path.Combine(Path.GetTempPath(), "praxis-nested-root-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(repository);
        try
        {
            Git(repository, "init");
            var root = Path.Combine(repository, "apps", "web"); Directory.CreateDirectory(Path.Combine(root, "renderer"));
            File.WriteAllText(Path.Combine(repository, ".gitignore"), "apps/web/renderer/\n");
            File.WriteAllText(Path.Combine(root, "renderer", "Built.ts"), "export const built = 1;");
            File.WriteAllText(Path.Combine(root, "Huge.ts"), "export const huge = '" + new string('x', SourceFiles.MaximumBytes) + "';");
            File.WriteAllText(Path.Combine(root, "App.ts"), "export const app = 1;");
            var source = Assert.Single(SourceScanner.Scan(root, [], CancellationToken.None));
            Assert.Equal("App.ts", source.Path);
        }
        finally { Directory.Delete(repository, recursive: true); }
    }
}
