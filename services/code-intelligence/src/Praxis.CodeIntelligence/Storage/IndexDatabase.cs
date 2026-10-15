using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace Praxis.CodeIntelligence.Storage;

/// <summary>Owns schema compatibility and connection policy; source files are never modified.</summary>
public sealed class IndexDatabase
{
    public const int SchemaVersion = 2;
    private static readonly (string Sql, string Checksum)[] Migrations = Enumerable.Range(1, SchemaVersion).Select(version =>
    {
        var sql = ReadMigration(version);
        return (sql, Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sql))));
    }).ToArray();
    public string Path { get; }

    public IndexDatabase(string path) => Path = System.IO.Path.GetFullPath(path);

    public SqliteConnection Open(bool readOnly = false)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = Path,
            Mode = readOnly ? SqliteOpenMode.ReadOnly : SqliteOpenMode.ReadWrite,
            Pooling = false,
            DefaultTimeout = 5
        }.ToString());
        try
        {
            connection.Open();
            Execute(connection, "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
            Validate(connection);
            return connection;
        }
        catch { connection.Dispose(); throw; }
    }

    public void Initialize()
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = Path, Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false
        }.ToString());
        connection.Open();
        Execute(connection, "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
        // Check a newer schema before changing persistent journal policy.
        var version = Version(connection);
        if (version != 0) { ValidateHistory(connection, version); if (version == SchemaVersion) return; }
        Execute(connection, "PRAGMA journal_mode=WAL;");
        using var transaction = connection.BeginTransaction(deferred: false);
        // Another initializer may have committed while this connection waited for the writer.
        version = Version(connection, transaction);
        if (version != 0) ValidateHistory(connection, version, transaction);
        for (var next = version + 1; next <= SchemaVersion; next++)
        {
            using var schema = connection.CreateCommand();
            schema.Transaction = transaction; schema.CommandText = Migrations[next - 1].Sql; schema.ExecuteNonQuery();
            using var record = connection.CreateCommand(); record.Transaction = transaction;
            record.CommandText = "INSERT INTO schema_migrations(version,checksum,applied_utc) VALUES($version,$checksum,$utc); PRAGMA user_version=" + next.ToString(CultureInfo.InvariantCulture) + ";";
            record.Parameters.AddWithValue("$version", next);
            record.Parameters.AddWithValue("$checksum", Migrations[next - 1].Checksum);
            record.Parameters.AddWithValue("$utc", DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
            record.ExecuteNonQuery();
        }
        transaction.Commit();
    }

    public IReadOnlyList<string> Check()
    {
        using var connection = Open(readOnly: true);
        var errors = new List<string>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "PRAGMA quick_check;";
            using var reader = command.ExecuteReader();
            while (reader.Read()) if (reader.GetString(0) != "ok") errors.Add(reader.GetString(0));
        }
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "PRAGMA foreign_key_check;";
            using var reader = command.ExecuteReader();
            while (reader.Read()) errors.Add($"Foreign key violation in {reader.GetString(0)}.");
        }
        return errors;
    }

    public void Backup(string destination)
    {
        destination = System.IO.Path.GetFullPath(destination);
        if (string.Equals(destination, Path, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new ArgumentException("Backup must use a different path.", nameof(destination));
        if (File.Exists(destination)) throw new IOException("Backup destination already exists.");
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(destination)!);
        var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var source = Open(readOnly: true))
            using (var target = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = temporary, Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false
            }.ToString()))
            {
                target.Open();
                source.BackupDatabase(target);
            }
            if (new IndexDatabase(temporary).Check().Count != 0) throw new IOException("Backup validation failed.");
            File.Move(temporary, destination, overwrite: false);
        }
        finally
        {
            File.Delete(temporary);
            File.Delete(temporary + "-wal");
            File.Delete(temporary + "-shm");
        }
    }

    private static void Validate(SqliteConnection connection, SqliteTransaction? transaction = null)
    {
        var version = Version(connection, transaction);
        if (version != SchemaVersion) throw new InvalidOperationException("INDEX_VERSION_UNSUPPORTED: incompatible schema version.");
        ValidateHistory(connection, version, transaction);
    }

    private static void ValidateHistory(SqliteConnection connection, int version, SqliteTransaction? transaction = null)
    {
        if (version < 1 || version > SchemaVersion) throw new InvalidOperationException("INDEX_VERSION_UNSUPPORTED: incompatible schema version.");
        using var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = "SELECT version,checksum FROM schema_migrations ORDER BY version";
        using var reader = command.ExecuteReader(); var applied = 0;
        while (reader.Read())
        {
            applied++;
            if (applied > version || reader.GetInt32(0) != applied || reader.GetString(1) != Migrations[applied - 1].Checksum)
                throw new InvalidOperationException("INDEX_VERSION_UNSUPPORTED: migration checksum mismatch.");
        }
        if (applied != version) throw new InvalidOperationException("INDEX_VERSION_UNSUPPORTED: migration history is incomplete.");
    }

    private static int Version(SqliteConnection connection, SqliteTransaction? transaction = null)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "PRAGMA user_version;";
        return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    private static void Execute(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand(); command.CommandText = sql; command.ExecuteNonQuery();
    }

    private static string ReadMigration(int version)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"Praxis.CodeIntelligence.Storage.migration{version:D3}.sql")
            ?? throw new InvalidOperationException("Embedded migration missing.");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }
}
