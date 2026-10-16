using System.Runtime;

namespace Praxis.CodeIntelligence.Storage;

/// <summary>
/// Specification §31.3 memory admission: the 2 GiB reference budget covers the
/// whole process. At 80% of it, new read connections stop mapping the file and
/// keep only a small page cache, and finished publication/refresh work returns
/// retained managed memory. Results are unaffected; only caching changes.
/// </summary>
public static class MemoryPressure
{
    public const long BudgetBytes = 2L * 1024 * 1024 * 1024;
    public const long SoftLimitBytes = BudgetBytes / 5 * 4;
    public const int PressureReadPageCacheKiB = 2 * 1024;
    // Injectable only for deterministic tests.
    internal static Func<long> ResidentBytes { get; set; } = () => Environment.WorkingSet;

    public static bool Active => ResidentBytes() >= SoftLimitBytes;

    // Called after publication or vector refresh. A compacting collection is
    // expensive, so it runs only when the process is already under pressure.
    public static void RelieveAfterWork()
    {
        if (!Active) return;
        GCSettings.LargeObjectHeapCompactionMode = GCLargeObjectHeapCompactionMode.CompactOnce;
        GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
    }

    public static object Status()
    {
        var resident = ResidentBytes();
        return new { residentBytes = resident, softLimitBytes = SoftLimitBytes, budgetBytes = BudgetBytes, pressure = resident >= SoftLimitBytes };
    }
}
