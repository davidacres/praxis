using System.Collections.Concurrent;
using Praxis.CodeIntelligence.Indexing;

namespace Praxis.CodeIntelligence.Host;

/// <summary>Watchers are hints; periodic bounded reconciliation remains the freshness authority.</summary>
public sealed class RepositoryMonitor : IDisposable
{
    private sealed record Dirty(DateTimeOffset First, DateTimeOffset Last);
    private readonly Dictionary<string, FileSystemWatcher> watchers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DateTimeOffset> retryAfter = new(StringComparer.Ordinal);
    private readonly Dictionary<string, DateTimeOffset> reconciled = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Dirty> dirty = new(StringComparer.Ordinal);

    public IReadOnlyList<string> Poll(IReadOnlyList<RepositoryRecord> repositories)
    {
        var now = DateTimeOffset.UtcNow; var live = repositories.Where(r => r.State != "paused").ToDictionary(r => r.Id, StringComparer.Ordinal);
        foreach (var id in watchers.Keys.Where(id => !live.ContainsKey(id)).ToArray()) { watchers[id].Dispose(); watchers.Remove(id); }
        foreach (var id in reconciled.Keys.Where(id => !live.ContainsKey(id)).ToArray()) { reconciled.Remove(id); retryAfter.Remove(id); dirty.TryRemove(id, out _); }
        foreach (var repository in live.Values)
        {
            if (!watchers.ContainsKey(repository.Id) && (!retryAfter.TryGetValue(repository.Id, out var retry) || retry <= now))
            {
                try
                {
                    var watcher = new FileSystemWatcher(repository.Root) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size };
                    watcher.Changed += (_, e) => Changed(repository, e.FullPath); watcher.Created += (_, e) => Changed(repository, e.FullPath);
                    watcher.Deleted += (_, e) => Changed(repository, e.FullPath); watcher.Renamed += (_, e) => { Changed(repository, e.OldFullPath); Changed(repository, e.FullPath); };
                    watcher.Error += (_, _) => Mark(repository.Id);
                    watcher.EnableRaisingEvents = true; watchers[repository.Id] = watcher; retryAfter.Remove(repository.Id); Mark(repository.Id);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
                { retryAfter[repository.Id] = now.AddSeconds(30); Mark(repository.Id); }
            }
            if (!reconciled.TryGetValue(repository.Id, out var last) || now - last >= TimeSpan.FromSeconds(60))
            { reconciled[repository.Id] = now; Mark(repository.Id); }
        }
        var ready = new List<string>();
        foreach (var item in dirty)
            if (live.ContainsKey(item.Key) && (now - item.Value.Last >= TimeSpan.FromMilliseconds(500) || now - item.Value.First >= TimeSpan.FromSeconds(2)))
                if (((ICollection<KeyValuePair<string, Dirty>>)dirty).Remove(item)) ready.Add(item.Key);
        return ready;
    }
    private void Changed(RepositoryRecord repository, string fullPath)
    {
        var relative = Path.GetRelativePath(repository.Root, fullPath).Replace('\\', '/');
        if (SourceScanner.IsExcluded(relative, repository.Config.Excludes ?? [])) return;
        if (relative.Split('/').Any(part => part is ".git" or "bin" or "obj" or "node_modules" or "vendor" or "dist")) return;
        var extension = Path.GetExtension(fullPath);
        if (extension.Length == 0 || extension is ".cs" or ".csproj" or ".props" or ".targets" || relative.EndsWith(".praxis.json", StringComparison.OrdinalIgnoreCase)
            || Path.GetFileName(fullPath) is ".gitignore" or ".editorconfig") Mark(repository.Id);
    }
    private void Mark(string id)
    {
        var now = DateTimeOffset.UtcNow;
        dirty.AddOrUpdate(id, _ => new(now, now), (_, existing) => existing with { Last = now });
    }
    public void Dispose() { foreach (var watcher in watchers.Values) watcher.Dispose(); watchers.Clear(); }
}
