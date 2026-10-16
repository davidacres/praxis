using Microsoft.Data.Sqlite;

namespace Praxis.CodeIntelligence.Storage;

/// <summary>Classifies storage failures that callers must treat as a full volume.</summary>
public static class StorageFailures
{
    private const int SqliteFull = 13;
    private const int UnixNoSpace = 28;
    private const int WindowsHandleDiskFull = 39, WindowsDiskFull = 112;

    private const int SqliteIoError = 10, SqliteCantOpen = 14;
    internal const long NearlyFullBytes = 16L * 1024 * 1024;

    // SQLite reports SQLITE_FULL; file APIs surface ENOSPC or the Windows
    // disk-full codes, sometimes wrapped. When SQLite cannot even create its
    // -wal/-shm files it reports CANTOPEN/IOERR instead, so with a volume path
    // those count too once that volume is nearly out of space.
    public static bool IsDiskFull(Exception? error, string? volumePath = null)
    {
        var storageFailure = false;
        for (var current = error; current is not null; current = current.InnerException)
        {
            if (current is SqliteException sqlite)
            {
                if ((sqlite.SqliteErrorCode & 0xFF) == SqliteFull) return true;
                storageFailure |= (sqlite.SqliteErrorCode & 0xFF) is SqliteIoError or SqliteCantOpen;
            }
            if (current is IOException io)
            {
                if (OperatingSystem.IsWindows() ? (io.HResult & 0xFFFF) is WindowsHandleDiskFull or WindowsDiskFull : io.HResult == UnixNoSpace) return true;
                storageFailure = true;
            }
        }
        return storageFailure && volumePath is not null && AvailableBytes(volumePath) is < NearlyFullBytes;
    }

    private static long? AvailableBytes(string path)
    {
        try { return new DriveInfo(Path.GetFullPath(path)).AvailableFreeSpace; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException) { return null; }
    }
}
