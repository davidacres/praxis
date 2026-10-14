using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace Praxis.CodeIntelligence.Storage;

/// <summary>Owns schema compatibility and connection policy; source files are never modified.</summary>
public sealed class IndexDatabase
{
    public const int SchemaVersion = 1;
    private static readonly string Migration = ReadMigration();
    private static readonly string Checksum = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Migration)));
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
        if (version != 0) { Validate(connection); return; }
        Execute(connection, "PRAGMA journal_mode=WAL;");
        using var transaction = connection.BeginTransaction(deferred: false);
        // Another initializer may have committed while this connection waited for the writer.
        version = Version(connection, transaction);
        if (version == 0)
        {
            using var schema = connection.CreateCommand();
            schema.Transaction = transaction;
            schema.CommandText = Migration;
            schema.ExecuteNonQuery();
            using var record = connection.CreateCommand();
            record.Transaction = transaction;
            record.CommandText = "INSERT INTO schema_migrations(version,checksum,applied_utc) VALUES($version,$checksum,$utc); PRAGMA user_version=1;";
            record.Parameters.AddWithValue("$version", SchemaVersion);
            record.Parameters.AddWithValue("$checksum", Checksum);
            record.Parameters.AddWithValue("$utc", DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
            record.ExecuteNonQuery();
        }
        else Validate(connection, transaction);
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
        if (Version(connection, transaction) != SchemaVersion)
            throw new InvalidOperationException("INDEX_VERSION_UNSUPPORTED: incompatible schema version.");
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT checksum FROM schema_migrations WHERE version=$version";
        command.Parameters.AddWithValue("$version", SchemaVersion);
        if (command.ExecuteScalar() is not string checksum || checksum != Checksum)
            throw new InvalidOperationException("INDEX_VERSION_UNSUPPORTED: migration checksum mismatch.");
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

    private static string ReadMigration()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Praxis.CodeIntelligence.Storage.migration001.sql")
            ?? throw new InvalidOperationException("Embedded migration missing.");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }
}
