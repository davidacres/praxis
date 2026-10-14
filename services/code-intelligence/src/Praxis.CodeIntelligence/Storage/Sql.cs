using Microsoft.Data.Sqlite;

namespace Praxis.CodeIntelligence.Storage;

internal static class Sql
{
    public static SqliteCommand Command(this SqliteConnection connection, SqliteTransaction? transaction, string sql, params object?[] values)
    {
        var command = connection.CreateCommand(); command.Transaction = transaction; command.CommandText = sql;
        for (var i = 0; i < values.Length; i++) command.Parameters.AddWithValue("$" + i, values[i] ?? DBNull.Value);
        return command;
    }
    public static int Execute(this SqliteConnection connection, SqliteTransaction? transaction, string sql, params object?[] values)
    { using var command = connection.Command(transaction, sql, values); return command.ExecuteNonQuery(); }
    public static object? Scalar(this SqliteConnection connection, SqliteTransaction? transaction, string sql, params object?[] values)
    { using var command = connection.Command(transaction, sql, values); return command.ExecuteScalar(); }
}
