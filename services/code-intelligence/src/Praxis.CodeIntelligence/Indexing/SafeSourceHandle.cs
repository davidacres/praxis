using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Praxis.CodeIntelligence.Indexing;

internal static class SafeSourceHandle
{
    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int Open([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);
    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenAt(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    // Apple XNU bsd/sys/fcntl.h: F_GETPATH=50, O_NOFOLLOW=0x100,
    // O_DIRECTORY=0x100000, O_CLOEXEC=0x1000000.
    // https://github.com/apple/darwin-xnu/blob/main/bsd/sys/fcntl.h
    [DllImport("libc", EntryPoint = "fcntl", SetLastError = true)]
    private static extern int GetMacPath(int descriptor, int command, [Out] byte[] buffer);
    // Darwin arm64 passes variadic arguments on the stack. Fill x2-x7 so the
    // buffer occupies the first stack argument; the ordinary overload is for x64.
    // https://github.com/dotnet/runtime/issues/48796
    [DllImport("libc", EntryPoint = "fcntl", SetLastError = true)]
    private static extern int GetMacArm64Path(int descriptor, int command,
        nint unused2, nint unused3, nint unused4, nint unused5, nint unused6, nint unused7, [Out] byte[] buffer);
    // https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew
    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetWindowsPath(SafeFileHandle file, StringBuilder path, uint capacity, uint flags);

    // Descriptor-relative traversal refuses source links at every Unix component.
    public static FileStream Read(string root, string relativePath, string expectedPath)
    {
        if (OperatingSystem.IsWindows())
        {
            var stream = new FileStream(expectedPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            try { Verify(stream, expectedPath); return stream; }
            catch { stream.Dispose(); throw; }
        }
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) throw new PlatformNotSupportedException("Source handles require a supported desktop platform.");
        var noFollow = OperatingSystem.IsMacOS() ? 0x100 : 0x20000;
        var directory = OperatingSystem.IsMacOS() ? 0x100000 : 0x10000;
        var closeOnExec = OperatingSystem.IsMacOS() ? 0x1000000 : 0x80000;
        var nonBlocking = OperatingSystem.IsMacOS() ? 0x4 : 0x800;
        using var rootHandle = Handle(Open(SourceFiles.CanonicalDirectory(root), noFollow | directory | closeOnExec));
        var rootPath = OpenedPath(rootHandle);
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
            var file = Handle(OpenAt(current.DangerousGetHandle().ToInt32(), parts[^1], noFollow | closeOnExec | nonBlocking));
            try
            {
                var openedPath = OpenedPath(file);
                if (openedPath != expectedPath) throw new IOException("Source path changed during opening.");
                return new FileStream(file, FileAccess.Read);
            }
            catch { file.Dispose(); throw; }
        }
        finally { foreach (var parent in parents) parent.Dispose(); }
    }
    public static void Verify(FileStream stream, string expectedPath)
    {
        var actual = OpenedPath(stream.SafeFileHandle);
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (!string.Equals(actual, NormalizeWindowsPath(expectedPath), comparison)) throw new IOException("Opened source path changed during reading.");
    }
    private static string NormalizeWindowsPath(string path)
    {
        if (!OperatingSystem.IsWindows()) return path;
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + path[8..];
        return path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path[4..] : path;
    }
    private static string OpenedPath(SafeFileHandle handle)
    {
        if (OperatingSystem.IsWindows())
        {
            var path = new StringBuilder(32768);
            var length = GetWindowsPath(handle, path, (uint)path.Capacity, 0);
            if (length == 0 || length >= path.Capacity) throw new IOException("Cannot verify the opened source path.");
            return NormalizeWindowsPath(path.ToString());
        }
        if (OperatingSystem.IsMacOS())
        {
            var bytes = new byte[4096];
            var result = RuntimeInformation.ProcessArchitecture == Architecture.Arm64
                ? GetMacArm64Path(handle.DangerousGetHandle().ToInt32(), 50, 0, 0, 0, 0, 0, 0, bytes)
                : GetMacPath(handle.DangerousGetHandle().ToInt32(), 50, bytes);
            if (result != 0) throw new IOException("Cannot verify the opened source path.");
            var end = Array.IndexOf(bytes, (byte)0);
            if (end <= 0) throw new IOException("Opened source path is unavailable.");
            return new UTF8Encoding(false, true).GetString(bytes, 0, end);
        }
        return File.ResolveLinkTarget("/proc/self/fd/" + handle.DangerousGetHandle().ToInt32(), returnFinalTarget: true)?.FullName
            ?? throw new IOException("Opened source path is unavailable.");
    }
    private static SafeFileHandle Handle(int descriptor)
    {
        if (descriptor < 0) throw new IOException("Source cannot be opened without following links.");
        return new SafeFileHandle((IntPtr)descriptor, ownsHandle: true);
    }
}
