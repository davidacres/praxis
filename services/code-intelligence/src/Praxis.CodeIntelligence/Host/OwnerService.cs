using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Praxis.CodeIntelligence.Indexing;

namespace Praxis.CodeIntelligence.Host;

public static class OwnerService
{
    private sealed class Admission { public readonly SemaphoreSlim Slots = new(4, 4); public int Waiting; }

    /// <summary>
    /// Actions admitted beside the writer: queries, and reads or grant-file changes that never
    /// write the index. Background jobs hold the writer for a whole index or vector build, so
    /// anything queued behind it could wait minutes and hit the request deadline. A grant
    /// written during a relocation stays safe: queries re-check its root and fail closed.
    /// </summary>
    internal static bool RunsBesideWriter(string? action) => action is "query" or "list" or "grants" or "grant" or "revoke";

    /// <summary>
    /// This build's identity: the module version ID, which deterministic compilation derives
    /// from the code. A client compares it with a running owner's to tell whether that owner
    /// still runs old code — an owner outlives the app that started it.
    /// </summary>
    public static string Build { get; } = Assembly.GetExecutingAssembly().ManifestModule.ModuleVersionId.ToString("N");

    public static async Task RunAsync(string directory, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(directory); directory = SourceFiles.CanonicalDirectory(directory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        using var ownerLock = new FileStream(Path.Combine(directory, "owner.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        var endpoint = Endpoint(directory); if (!OperatingSystem.IsWindows()) File.Delete(endpoint);
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)); using var runtime = new ServiceRuntime(directory);
        var startedUtc = DateTimeOffset.UtcNow.ToString("O");
        runtime.Scheduler.ReclaimAbandonedLeases(); // safe: this process holds the exclusive owner lock
        runtime.ScheduleStartupReconciliation();
        using var writer = new SemaphoreSlim(1, 1); using var clients = new SemaphoreSlim(16, 16);
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var admissions = new ConcurrentDictionary<string, Admission>(StringComparer.Ordinal);
        var active = new ConcurrentDictionary<Guid, Task>(); var lastActivity = DateTimeOffset.UtcNow;
        var rendezvous = Path.Combine(directory, "owner.json"); var staging = rendezvous + "." + Guid.NewGuid().ToString("N") + ".tmp";
        NamedPipeServerStream? next = Server(endpoint);
        try
        {
            // nosemgrep: csharp.lang.security.filesystem.unsafe-path-combine.unsafe-path-combine -- fixed file name under the owner directory
            File.WriteAllText(staging, new JsonObject { ["version"] = 1, ["endpoint"] = endpoint, ["token"] = token,
                ["processId"] = Environment.ProcessId, ["build"] = Build, ["startedUtc"] = startedUtc }.ToJsonString());
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(staging, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(staging, rendezvous, overwrite: true);
            var maintenance = Task.Run(async () =>
            {
                // Keep scheduler quantization below the watcher debounce budget.
                using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(100));
                while (await timer.WaitForNextTickAsync(lifetime.Token))
                {
                    if (active.IsEmpty && DateTimeOffset.UtcNow - lastActivity > TimeSpan.FromMinutes(5)) { lifetime.Cancel(); break; }
                    await writer.WaitAsync(lifetime.Token);
                    try
                    {
                        await runtime.MaintainAsync(lifetime.Token);
                    }
                    finally { writer.Release(); }
                }
            }, lifetime.Token);
            try
            {
                while (!lifetime.IsCancellationRequested)
                {
                    await clients.WaitAsync(lifetime.Token); var pipe = next; next = null;
                    try
                    {
                        await pipe.WaitForConnectionAsync(lifetime.Token); next = Server(endpoint);
                        var taskId = Guid.NewGuid(); lastActivity = DateTimeOffset.UtcNow; var task = Handle(pipe); active[taskId] = task;
                        _ = task.ContinueWith(completed => { active.TryRemove(taskId, out _); clients.Release(); lastActivity = DateTimeOffset.UtcNow; }, TaskScheduler.Default);
                    }
                    catch { pipe.Dispose(); clients.Release(); throw; }
                }
            }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
            finally
            {
                lifetime.Cancel(); next?.Dispose(); next = null;
                try { await maintenance; } catch (OperationCanceledException) { }
                try { await Task.WhenAll(active.Values).WaitAsync(TimeSpan.FromSeconds(5)); } catch (TimeoutException) { }
            }
        }
        finally { next?.Dispose(); File.Delete(staging); File.Delete(rendezvous); if (!OperatingSystem.IsWindows()) File.Delete(endpoint); }

        async Task Handle(NamedPipeServerStream pipe)
        {
            using (pipe)
            using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token))
            {
                deadline.CancelAfter(TimeSpan.FromMinutes(2));
                try
                {
                    var frame = await Framing.ReadAsync(pipe, Framing.MaximumRequestBytes, deadline.Token);
                    var supplied = frame["token"]?.GetValue<string>() ?? "";
                    if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied), Encoding.UTF8.GetBytes(token)))
                    {
                        var rejected = ServiceRuntime.Error("ACCESS_DENIED", "Owner authentication failed.");
                        rejected["handshake"] = "authenticationRejected";
                        await Framing.WriteAsync(pipe, rejected, Framing.MaximumResponseBytes, deadline.Token); return;
                    }
                    var request = frame["request"]!.AsObject();
                    // Owner lifecycle requests answer at once, never queued behind a long writer job.
                    if (request["action"]?.GetValue<string>() is "owner-status" or "shutdown")
                    {
                        var shutdown = request["action"]!.GetValue<string>() == "shutdown";
                        await Framing.WriteAsync(pipe, new JsonObject { ["data"] = new JsonObject { ["running"] = !shutdown, ["stopping"] = shutdown,
                            ["processId"] = Environment.ProcessId, ["build"] = Build, ["startedUtc"] = startedUtc } }, Framing.MaximumResponseBytes, deadline.Token);
                        // Graceful: the loops end, in-flight requests get five seconds, an interrupted
                        // background job is reclaimed by the next owner like any lost lease.
                        if (shutdown) lifetime.Cancel();
                        return;
                    }
                    var besideWriter = RunsBesideWriter(request["action"]?.GetValue<string>());
                    var repository = request["arguments"]?["repositoryId"]?.GetValue<string>() ?? request["repositoryId"]?.GetValue<string>() ?? "local";
                    if (request["action"]?.GetValue<string>() is "pause" or "unregister" or "rebuild" or "relocate") runtime.CancelRepositoryWork(repository);
                    var admission = admissions.GetOrAdd(repository, _ => new Admission());
                    if (Interlocked.Increment(ref admission.Waiting) > 32)
                    {
                        Interlocked.Decrement(ref admission.Waiting);
                        await Framing.WriteAsync(pipe, ServiceRuntime.Error("BUSY", "Repository request queue is full."), Framing.MaximumResponseBytes, deadline.Token); return;
                    }
                    var semaphore = besideWriter ? admission.Slots : writer;
                    try { await semaphore.WaitAsync(deadline.Token); } finally { Interlocked.Decrement(ref admission.Waiting); }
                    try
                    {
                        var disconnect = WatchDisconnect(pipe, deadline);
                        var response = await Task.Run(() => runtime.Dispatch(request, deadline.Token), deadline.Token);
                        await Framing.WriteAsync(pipe, response, Framing.MaximumResponseBytes, deadline.Token);
                        deadline.Cancel(); try { await disconnect; } catch (OperationCanceledException) { }
                    }
                    finally { semaphore.Release(); }
                }
                catch (Exception ex) when (ex is IOException or OperationCanceledException or System.Text.Json.JsonException or InvalidOperationException) { }
                catch (Exception)
                {
                    // Never drop a client without a coded reply; no details or stack traces.
                    try { await Framing.WriteAsync(pipe, ServiceRuntime.Error("INTERNAL_ERROR", "The owner could not complete the request."), Framing.MaximumResponseBytes, lifetime.Token); }
                    catch (Exception reply) when (reply is IOException or OperationCanceledException or ObjectDisposedException) { }
                }
            }
        }
    }

    public static async Task<JsonObject> SendAsync(string directory, JsonObject request, CancellationToken cancellationToken)
    {
        directory = Path.GetFullPath(directory); Directory.CreateDirectory(directory); directory = SourceFiles.CanonicalDirectory(directory);
        Process? startup = null; var rendezvous = Path.Combine(directory, "owner.json"); var submitted = false;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); deadline.CancelAfter(TimeSpan.FromSeconds(15));
        try
        {
            while (!deadline.IsCancellationRequested)
            {
                if (File.Exists(rendezvous))
                    try
                    {
                        // nosemgrep: csharp.lang.security.filesystem.unsafe-path-combine.unsafe-path-combine -- fixed file name under the owner directory
                        var bytes = File.ReadAllBytes(rendezvous); if (bytes.Length > 4096) throw new IOException("Invalid owner rendezvous.");
                        var owner = JsonNode.Parse(bytes)!; var endpoint = owner["endpoint"]!.GetValue<string>();
                        if (endpoint != Endpoint(directory) || owner["version"]!.GetValue<int>() != 1) throw new IOException("Invalid owner endpoint.");
                        using var pipe = new NamedPipeClientStream(".", endpoint, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                        await pipe.ConnectAsync(300, deadline.Token);
                        submitted = true; // Never replay a mutation after an uncertain execution/disconnect.
                        await Framing.WriteAsync(pipe, new JsonObject { ["token"] = owner["token"]!.DeepClone(), ["request"] = request.DeepClone() }, Framing.MaximumRequestBytes, deadline.Token);
                        using var execution = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); execution.CancelAfter(TimeSpan.FromMinutes(2));
                        var response = await Framing.ReadAsync(pipe, Framing.MaximumResponseBytes, execution.Token);
                        if (response["handshake"]?.GetValue<string>() == "authenticationRejected")
                        {
                            // A replacement owner can accept before a client refreshes
                            // its rendezvous. This explicit pre-dispatch rejection proves
                            // the request did not execute; uncertain disconnects still never replay.
                            submitted = false;
                            await Task.Delay(25, deadline.Token); continue;
                        }
                        return response;
                    }
                    catch (Exception ex) when (!submitted && ex is IOException or TimeoutException or System.Text.Json.JsonException) { }
                startup ??= Start(directory);
                if (startup.HasExited && startup.ExitCode != 0 && !File.Exists(rendezvous))
                    throw new IOException("Owner startup failed. " + (StartupFailure(startup) is { Length: > 0 } reason ? reason : "Local IPC permissions or owner locking may be unavailable."));
                await Task.Delay(100, deadline.Token);
            }
            throw new IOException("Owner startup timed out.");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw new IOException("Owner startup timed out."); }
        finally { startup?.Dispose(); }
    }
    /// <summary>The running owner's status, or <c>running: false</c>. Never starts an owner.</summary>
    public static async Task<JsonObject> ProbeAsync(string directory, CancellationToken cancellationToken)
    {
        var (response, processId) = await TrySendToRunningAsync(directory, new JsonObject { ["action"] = "owner-status" }, cancellationToken);
        if (response is null) return new JsonObject { ["running"] = false };
        // An owner from before lifecycle requests answers with an error: it is running, but its
        // build is unknown, so a client must treat it as another build.
        return response["data"] as JsonObject is { } data ? data.DeepClone().AsObject()
            : new JsonObject { ["running"] = true, ["processId"] = processId, ["build"] = null, ["startedUtc"] = null };
    }

    /// <summary>Asks a running owner to shut down and waits for it to exit. Never starts an owner.</summary>
    public static async Task<JsonObject> StopAsync(string directory, CancellationToken cancellationToken)
    {
        var (response, processId) = await TrySendToRunningAsync(directory, new JsonObject { ["action"] = "shutdown" }, cancellationToken);
        if (response is null || processId is null) return new JsonObject { ["stopped"] = false, ["running"] = false };
        var rendezvous = Path.Combine(SourceFiles.CanonicalDirectory(directory), "owner.json");
        if (response["data"] is not JsonObject data)
        {
            // An owner from before lifecycle requests cannot shut down on request. It just proved
            // it is this directory's authenticated owner, so end it as a crash would; the next
            // owner reclaims its leases (see the crash-recovery qualification).
            try { using var legacy = Process.GetProcessById(processId.Value); legacy.Kill(); await legacy.WaitForExitAsync(cancellationToken); }
            catch (ArgumentException) { } // already gone
            if (OwnerProcess(rendezvous) == processId) File.Delete(rendezvous);
            return new JsonObject { ["stopped"] = true, ["running"] = false, ["processId"] = processId };
        }
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); deadline.CancelAfter(TimeSpan.FromSeconds(20));
        // The owner removes its rendezvous as its last act; a replacement writes a new one
        // with another process ID, which also means this one has gone.
        while (File.Exists(rendezvous) && OwnerProcess(rendezvous) == data["processId"]!.GetValue<int>())
            await Task.Delay(50, deadline.Token);
        return new JsonObject { ["stopped"] = true, ["running"] = false, ["processId"] = data["processId"]!.DeepClone() };
    }

    private static int? OwnerProcess(string rendezvous)
    {
        try { return JsonNode.Parse(File.ReadAllBytes(rendezvous))?["processId"]?.GetValue<int>(); }
        catch (Exception ex) when (ex is IOException or System.Text.Json.JsonException or InvalidOperationException) { return null; }
    }

    /// <summary>
    /// Sends to an owner already running, with its process ID. A null response means none is
    /// reachable. An error response still proves a live, authenticated owner.
    /// </summary>
    private static async Task<(JsonObject? Response, int? ProcessId)> TrySendToRunningAsync(string directory, JsonObject request, CancellationToken cancellationToken)
    {
        directory = Path.GetFullPath(directory);
        if (!Directory.Exists(directory)) return (null, null);
        directory = SourceFiles.CanonicalDirectory(directory);
        var rendezvous = Path.Combine(directory, "owner.json");
        if (!File.Exists(rendezvous)) return (null, null);
        try
        {
            var bytes = File.ReadAllBytes(rendezvous); if (bytes.Length > 4096) return (null, null);
            var owner = JsonNode.Parse(bytes)!; var endpoint = owner["endpoint"]!.GetValue<string>();
            if (endpoint != Endpoint(directory) || owner["version"]!.GetValue<int>() != 1) return (null, null);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); deadline.CancelAfter(TimeSpan.FromSeconds(10));
            using var pipe = new NamedPipeClientStream(".", endpoint, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await pipe.ConnectAsync(1000, deadline.Token);
            await Framing.WriteAsync(pipe, new JsonObject { ["token"] = owner["token"]!.DeepClone(), ["request"] = request.DeepClone() }, Framing.MaximumRequestBytes, deadline.Token);
            var response = await Framing.ReadAsync(pipe, Framing.MaximumResponseBytes, deadline.Token);
            // A rejected token is not proof of anything; only a dispatched answer is.
            return response["handshake"]?.GetValue<string>() == "authenticationRejected" ? (null, null) : (response, owner["processId"]?.GetValue<int>());
        }
        // A stale rendezvous from a crashed owner, or one exiting right now: nothing is running.
        catch (Exception ex) when (ex is IOException or TimeoutException or System.Text.Json.JsonException or InvalidOperationException or OperationCanceledException && !cancellationToken.IsCancellationRequested) { return (null, null); }
    }

    private static NamedPipeServerStream Server(string endpoint) => new(endpoint, PipeDirection.InOut, 16, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
    internal static string Endpoint(string directory)
    {
        if (OperatingSystem.IsWindows()) return "praxis-code-intelligence-" + Identity.Id("", directory)[..24];
        var path = Path.Combine(directory, "owner.sock"); if (Encoding.UTF8.GetByteCount(path) > 100) throw new IOException("Owner directory is too long for a Unix socket."); return path;
    }
    private static Process Start(string directory)
    {
        var executable = Environment.ProcessPath ?? throw new IOException("Service executable is unavailable.");
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase)) start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
        start.ArgumentList.Add("serve"); start.ArgumentList.Add("--data"); start.ArgumentList.Add(directory);
        var process = Process.Start(start) ?? throw new IOException("Cannot start owner.");
        // Keep only the owner's last few error lines so a startup failure can name its cause.
        var lines = new Queue<string>(); Failures.AddOrUpdate(process, lines);
        process.OutputDataReceived += (_, _) => { };
        process.ErrorDataReceived += (_, line) => { if (line.Data is { Length: > 0 } text) lock (lines) { lines.Enqueue(text.Length > 400 ? text[..400] : text); while (lines.Count > 3) lines.Dequeue(); } };
        process.BeginOutputReadLine(); process.BeginErrorReadLine(); return process;
    }
    private static readonly System.Runtime.CompilerServices.ConditionalWeakTable<Process, Queue<string>> Failures = new();
    private static string StartupFailure(Process process)
    {
        process.WaitForExit(); // flush asynchronous stderr reads
        if (!Failures.TryGetValue(process, out var lines)) return "";
        string line; lock (lines) line = lines.LastOrDefault(entry => entry.Contains(':')) ?? lines.LastOrDefault() ?? "";
        var separator = line.IndexOf(": ", StringComparison.Ordinal); // drop the owner's own error-code prefix
        return separator > 0 && line[..separator].All(character => char.IsAsciiLetterUpper(character) || character == '_') ? line[(separator + 2)..] : line;
    }
    private static async Task WatchDisconnect(Stream stream, CancellationTokenSource cancellation)
    {
        var probe = new byte[1];
        try { await stream.ReadExactlyAsync(probe, cancellation.Token); } catch (EndOfStreamException) { }
        cancellation.Cancel();
    }
}
