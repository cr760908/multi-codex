using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

// A Windows GUI-subsystem executable retains redirected handles without opening a console.
// Only executable paths and process IDs are arguments; account material stays in private IPC.
internal static class Launcher {
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr Reserved1, Peb, Reserved2, Reserved3, Pid, ParentPid; }
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int kind, ref ProcessInfo info, int size, out int returned);
    private static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(c);
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    private static async Task Pump(Stream source, Stream target) {
        byte[] buffer = new byte[16384]; int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length)) > 0) {
            await target.WriteAsync(buffer, 0, count);
            await target.FlushAsync();
        }
    }
    private static int Main(string[] args) {
        try {
            var info = new ProcessInfo(); int returned;
            if (NtQueryInformationProcess(Process.GetCurrentProcess().Handle, 0, ref info, Marshal.SizeOf(info), out returned) != 0) return 1;
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            string[] paths = File.ReadAllLines(Path.Combine(folder, "runtime-paths.txt"));
            if (paths.Length != 2 || !File.Exists(paths[0]) || !File.Exists(paths[1])) return 1;
            var command = new StringBuilder(Quote(Path.Combine(folder, "bridge.cjs")));
            command.Append(" ").Append(info.ParentPid.ToInt64()).Append(" ").Append(Quote(paths[1]));
            foreach (string arg in args) command.Append(" ").Append(Quote(arg));
            var start = new ProcessStartInfo(paths[0], command.ToString()) {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            using (var process = Process.Start(start)) {
                var input = Console.OpenStandardInput();
                Task.Run(async () => { try { await Pump(input, process.StandardInput.BaseStream); process.StandardInput.Close(); } catch {} });
                var stdout = Pump(process.StandardOutput.BaseStream, Console.OpenStandardOutput());
                var stderr = Pump(process.StandardError.BaseStream, Console.OpenStandardError());
                process.WaitForExit(); Task.WaitAll(stdout, stderr); return process.ExitCode;
            }
        } catch { return 1; }
    }
}
