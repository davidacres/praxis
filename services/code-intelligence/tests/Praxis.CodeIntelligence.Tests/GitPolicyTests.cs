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
            void Git(params string[] arguments)
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
            Git("init"); Git("config", "core.fsmonitor", "!touch should-not-exist");
            Directory.CreateDirectory(Path.Combine(root, "private"));
            File.WriteAllText(Path.Combine(root, ".gitignore"), "private/\nIgnored.cs\n");
            File.WriteAllBytes(Path.Combine(root, "private", "Secret.cs"), [0xff]); File.WriteAllBytes(Path.Combine(root, "Ignored.cs"), [0xff]);
            File.WriteAllText(Path.Combine(root, "Public.cs"), "class Public {}");
            var source = Assert.Single(SourceScanner.Scan(root, [], CancellationToken.None)); Assert.Equal("Public.cs", source.Path);
            Assert.False(File.Exists(Path.Combine(root, "should-not-exist")));
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
