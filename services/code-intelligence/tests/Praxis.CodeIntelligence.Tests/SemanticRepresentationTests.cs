using System.Text;
using Praxis.CodeIntelligence.Embeddings;
using Praxis.CodeIntelligence.Indexing;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class SemanticRepresentationTests
{
    [Theory]
    [InlineData(2)]
    [InlineData(4)]
    public void FormatUpgradePublishesEvenWhenSourceAndCompilerFactsAreUnchanged(int previousVersion)
    {
        var root = Path.Combine(Path.GetTempPath(), "pci-format-upgrade-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            File.WriteAllText(Path.Combine(root, "Example.cs"), "class Example { int ReadValue() => 1; }");
            var database = new Praxis.CodeIntelligence.Storage.IndexDatabase(Path.Combine(root, "data", "index.db"));
            database.Initialize();
            var indexer = new RepositoryIndexer(database);
            var repository = indexer.Register(root);
            var first = indexer.Index(repository);
            Assert.False(indexer.Index(repository).Changed);
            using (var connection = database.Open())
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "UPDATE contexts SET options_json=json_set(options_json,'$.representationFormat',$version)";
                command.Parameters.AddWithValue("$version", previousVersion);
                command.ExecuteNonQuery();
            }
            var upgrade = indexer.Index(repository);
            Assert.True(upgrade.Changed);
            Assert.True(upgrade.Generation > first.Generation);
            using (var connection = database.Open(readOnly: true))
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT count(*) FROM contexts WHERE json_extract(options_json,'$.representationFormat')=5";
                Assert.True(Convert.ToInt64(command.ExecuteScalar()) > 0);
            }
            Assert.False(indexer.Index(repository).Changed);
            Assert.Empty(database.Check());
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public void CSharpQualifiedRepresentationsKeepTheirExistingBytes()
    {
        var identity = "Product.Services.Reader.ReadValue()";
        var result = RepresentationBuilder.Build(identity, "int " + identity, "Reads a value.", "method " + identity);
        Assert.Equal(identity + "\nint " + identity + "\nReads a value.\nmethod " + identity, result.Text);
    }

}
