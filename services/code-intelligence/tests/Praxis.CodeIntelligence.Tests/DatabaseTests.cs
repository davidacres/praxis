using Microsoft.Data.Sqlite;
using Praxis.CodeIntelligence.Storage;
using Xunit;

namespace Praxis.CodeIntelligence.Tests;

public sealed class DatabaseTests : IDisposable
{
    private readonly string root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "praxis-ci-tests-" + Guid.NewGuid().ToString("N"));
    private IndexDatabase Database => new(System.IO.Path.Combine(root, "index.db"));

    [Fact]
    public void MigrationIsIdempotentAndEnforcesForeignKeys()
    {
        Database.Initialize(); Database.Initialize();
        using var connection = Database.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT count(*) FROM schema_migrations";
        Assert.Equal(1L, command.ExecuteScalar());
        command.CommandText = "INSERT INTO projects VALUES('p','missing','key','project.csproj','csharp')";
        Assert.Throws<SqliteException>(() => command.ExecuteNonQuery());
        Assert.Empty(Database.Check());
    }

    [Fact]
    public void NewerSchemaIsRejectedWithoutDowngrading()
    {
        Database.Initialize();
        using (var connection = Database.Open())
        {
            using var command = connection.CreateCommand(); command.CommandText = "PRAGMA user_version=2"; command.ExecuteNonQuery();
        }
        Assert.Throws<InvalidOperationException>(() => Database.Initialize());
        Assert.Throws<InvalidOperationException>(() => Database.Open());
        using var raw = new SqliteConnection($"Data Source={Database.Path};Pooling=False");
        raw.Open(); using var check = raw.CreateCommand(); check.CommandText = "PRAGMA user_version";
        Assert.Equal(2L, check.ExecuteScalar());
    }

    [Fact]
    public void ChecksumMismatchIsRejected()
    {
        Database.Initialize();
        using (var connection = Database.Open())
        {
            using var command = connection.CreateCommand(); command.CommandText = "UPDATE schema_migrations SET checksum='invalid'"; command.ExecuteNonQuery();
        }
        Assert.Throws<InvalidOperationException>(() => Database.Initialize());
    }

    [Fact]
    public void BackupContainsCommittedWalDataAndNeverOverwrites()
    {
        Database.Initialize();
        using (var connection = Database.Open())
        {
            using var command = connection.CreateCommand();
            command.CommandText = "INSERT INTO repositories(repository_id,canonical_root,path_policy) VALUES('repo','/fixture','caseSensitive')";
            command.ExecuteNonQuery();
        }
        var backup = System.IO.Path.Combine(root, "backup.db"); Database.Backup(backup);
        Assert.Empty(new IndexDatabase(backup).Check());
        using var read = new IndexDatabase(backup).Open(readOnly: true);
        using var count = read.CreateCommand(); count.CommandText = "SELECT count(*) FROM repositories";
        Assert.Equal(1L, count.ExecuteScalar());
        Assert.Throws<IOException>(() => Database.Backup(backup));
        Assert.Throws<ArgumentException>(() => Database.Backup(Database.Path));
    }

    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); }
}
