using Microsoft.Data.Sqlite;

namespace Praxis.CodeIntelligence.Storage;

internal static class Sql
{
    public static SqliteCommand Command(this SqliteConnection connection, SqliteTransaction? transaction, string sql, params object?[] values)
    {
        // nosemgrep: csharp.lang.security.sqli.csharp-sqli.csharp-sqli -- sql is a constant from the caller; values are bound as parameters
        var command = connection.CreateCommand(); command.Transaction = transaction; command.CommandText = sql;
        for (var i = 0; i < values.Length; i++) command.Parameters.AddWithValue("$" + i, values[i] ?? DBNull.Value);
        return command;
    }
    public static int Execute(this SqliteConnection connection, SqliteTransaction? transaction, string sql, params object?[] values)
    { using var command = connection.Command(transaction, sql, values); return command.ExecuteNonQuery(); }
    public static object? Scalar(this SqliteConnection connection, SqliteTransaction? transaction, string sql, params object?[] values)
    { using var command = connection.Command(transaction, sql, values); return command.ExecuteScalar(); }
}

/// <summary>Reuses prepared write commands for one publication transaction only.</summary>
internal sealed class SqlBatch(SqliteConnection connection, SqliteTransaction transaction) : IDisposable
{
    private readonly Dictionary<string, SqliteCommand> commands = new(StringComparer.Ordinal);
    public int Execute(string sql, params object?[] values)
    {
        if (!commands.TryGetValue(sql, out var command))
        {
            command = connection.Command(transaction, sql, values);
            try { command.Prepare(); commands.Add(sql, command); }
            catch { command.Dispose(); throw; }
        }
        else
        {
            if (command.Parameters.Count != values.Length) throw new ArgumentException("Prepared parameter count changed.");
            for (var i = 0; i < values.Length; i++) command.Parameters[i].Value = values[i] ?? DBNull.Value;
        }
        return command.ExecuteNonQuery();
    }
    public void Dispose()
    {
        foreach (var command in commands.Values) command.Dispose();
        commands.Clear();
    }
}
