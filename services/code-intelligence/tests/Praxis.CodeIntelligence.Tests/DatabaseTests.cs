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
        Assert.Equal((long)IndexDatabase.SchemaVersion, command.ExecuteScalar());
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
            using var command = connection.CreateCommand(); command.CommandText = "PRAGMA user_version=" + (IndexDatabase.SchemaVersion + 1); command.ExecuteNonQuery();
        }
        Assert.Throws<InvalidOperationException>(() => Database.Initialize());
        Assert.Throws<InvalidOperationException>(() => Database.Open());
        using var raw = new SqliteConnection($"Data Source={Database.Path};Pooling=False");
        raw.Open(); using var check = raw.CreateCommand(); check.CommandText = "PRAGMA user_version";
        Assert.Equal((long)IndexDatabase.SchemaVersion + 1, check.ExecuteScalar());
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
    public void VersionOneUpgradePreservesFactsAndAddsCascadeLookupIndexes()
    {
        Directory.CreateDirectory(root);
        using (var raw = new SqliteConnection($"Data Source={Database.Path};Pooling=False"))
        {
            raw.Open(); using var command = raw.CreateCommand();
            using var stream = typeof(IndexDatabase).Assembly.GetManifestResourceStream("Praxis.CodeIntelligence.Storage.migration001.sql")!;
            using var reader = new StreamReader(stream); var migration = reader.ReadToEnd();
            command.CommandText = migration; command.ExecuteNonQuery();
            var checksum = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(migration)));
            command.CommandText = "INSERT INTO schema_migrations VALUES(1,$checksum,'fixture'); PRAGMA user_version=1; INSERT INTO repositories(repository_id,canonical_root,path_policy) VALUES('kept','/fixture','caseSensitive');";
            command.Parameters.AddWithValue("$checksum", checksum); command.ExecuteNonQuery();
        }
        Database.Initialize(); Database.Initialize(); Assert.Empty(Database.Check());
        using var connection = Database.Open(); using var check = connection.CreateCommand();
        check.CommandText = "SELECT repository_id FROM repositories"; Assert.Equal("kept", check.ExecuteScalar());
        check.CommandText = "SELECT count(*) FROM schema_migrations"; Assert.Equal((long)IndexDatabase.SchemaVersion, check.ExecuteScalar());
        check.CommandText = "EXPLAIN QUERY PLAN SELECT edge_id FROM edges WHERE occurrence_id='fixture'";
        using var plan = check.ExecuteReader(); Assert.True(plan.Read()); Assert.Contains("edge_occurrence", plan.GetString(3));
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
