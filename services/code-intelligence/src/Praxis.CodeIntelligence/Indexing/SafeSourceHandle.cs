using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Praxis.CodeIntelligence.Indexing;

internal static class SafeSourceHandle
{
    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int Open([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);
    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenAt(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    // Linux descriptor-relative traversal refuses links at every source component, including during concurrent swaps.
    public static FileStream Read(string root, string relativePath, string expectedPath)
    {
        if (!OperatingSystem.IsLinux())
            return new FileStream(expectedPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        const int noFollow = 0x20000, directory = 0x10000, closeOnExec = 0x80000;
        using var rootHandle = Handle(Open(SourceFiles.CanonicalDirectory(root), noFollow | directory | closeOnExec));
        var rootPath = File.ResolveLinkTarget("/proc/self/fd/" + rootHandle.DangerousGetHandle().ToInt32(), returnFinalTarget: true)?.FullName;
        if (rootPath != SourceFiles.CanonicalDirectory(root)) throw new IOException("Source root changed during opening.");
        var parents = new List<SafeFileHandle>(); var current = rootHandle;
        try
        {
            var parts = relativePath.Split('/');
            for (var index = 0; index < parts.Length - 1; index++)
            {
                var parent = Handle(OpenAt(current.DangerousGetHandle().ToInt32(), parts[index], noFollow | directory | closeOnExec));
                parents.Add(parent); current = parent;
            }
            var file = Handle(OpenAt(current.DangerousGetHandle().ToInt32(), parts[^1], noFollow | closeOnExec));
            try
            {
                var openedPath = File.ResolveLinkTarget("/proc/self/fd/" + file.DangerousGetHandle().ToInt32(), returnFinalTarget: true)?.FullName;
                if (openedPath != expectedPath) throw new IOException("Source path changed during opening.");
                return new FileStream(file, FileAccess.Read);
            }
            catch { file.Dispose(); throw; }
        }
        finally { foreach (var parent in parents) parent.Dispose(); }
    }
    private static SafeFileHandle Handle(int descriptor)
    {
        if (descriptor < 0) throw new IOException("Source cannot be opened without following links.");
        return new SafeFileHandle((IntPtr)descriptor, ownsHandle: true);
    }
}
