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

    public static async Task RunAsync(string directory, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(directory); directory = SourceFiles.CanonicalDirectory(directory);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        using var ownerLock = new FileStream(Path.Combine(directory, "owner.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        var endpoint = Endpoint(directory); if (!OperatingSystem.IsWindows()) File.Delete(endpoint);
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)); using var runtime = new ServiceRuntime(directory);
        runtime.Scheduler.ReclaimAbandonedLeases(); // safe: this process holds the exclusive owner lock
        using var writer = new SemaphoreSlim(1, 1); using var clients = new SemaphoreSlim(16, 16);
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var admissions = new ConcurrentDictionary<string, Admission>(StringComparer.Ordinal);
        var active = new ConcurrentDictionary<Guid, Task>(); var lastActivity = DateTimeOffset.UtcNow;
        var rendezvous = Path.Combine(directory, "owner.json"); var staging = rendezvous + "." + Guid.NewGuid().ToString("N") + ".tmp";
        NamedPipeServerStream? next = Server(endpoint);
        try
        {
            File.WriteAllText(staging, new JsonObject { ["version"] = 1, ["endpoint"] = endpoint, ["token"] = token,
                ["processId"] = Environment.ProcessId }.ToJsonString());
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
                    var request = frame["request"]!.AsObject(); var query = request["action"]?.GetValue<string>() == "query";
                    var repository = request["arguments"]?["repositoryId"]?.GetValue<string>() ?? request["repositoryId"]?.GetValue<string>() ?? "local";
                    if (request["action"]?.GetValue<string>() is "pause" or "unregister" or "rebuild" or "relocate") runtime.CancelRepositoryWork(repository);
                    var admission = admissions.GetOrAdd(repository, _ => new Admission());
                    if (Interlocked.Increment(ref admission.Waiting) > 32)
                    {
                        Interlocked.Decrement(ref admission.Waiting);
                        await Framing.WriteAsync(pipe, ServiceRuntime.Error("BUSY", "Repository request queue is full."), Framing.MaximumResponseBytes, deadline.Token); return;
                    }
                    var semaphore = query ? admission.Slots : writer;
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
                if (startup.HasExited && startup.ExitCode != 0 && !File.Exists(rendezvous)) throw new IOException("Owner startup failed. Local IPC permissions or owner locking may be unavailable.");
                await Task.Delay(100, deadline.Token);
            }
            throw new IOException("Owner startup timed out.");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw new IOException("Owner startup timed out."); }
        finally { startup?.Dispose(); }
    }
    private static NamedPipeServerStream Server(string endpoint) => new(endpoint, PipeDirection.InOut, 16, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
    private static string Endpoint(string directory)
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
        process.OutputDataReceived += (_, _) => { }; process.ErrorDataReceived += (_, _) => { }; process.BeginOutputReadLine(); process.BeginErrorReadLine(); return process;
    }
    private static async Task WatchDisconnect(Stream stream, CancellationTokenSource cancellation)
    {
        var probe = new byte[1];
        try { await stream.ReadExactlyAsync(probe, cancellation.Token); } catch (EndOfStreamException) { }
        cancellation.Cancel();
    }
}
