// Foreground window detection. On Windows a long-lived PowerShell process answers each query in a few
// milliseconds (starting PowerShell per query would take 300+ ms, too slow for the shortcut).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ActiveWindow {
  title: string;
  process: string;
  app: string;
  pid: number;
}

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class OnCallForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $h = [OnCallForeground]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][OnCallForeground]::GetWindowText($h, $sb, 512)
  $procId = 0
  [void][OnCallForeground]::GetWindowThreadProcessId($h, [ref]$procId)
  $p = Get-Process -Id $procId
  $desc = ''
  try { $desc = $p.MainModule.FileVersionInfo.FileDescription } catch { $desc = '' }
  [Console]::Out.WriteLine((@{ title = $sb.ToString(); pid = [int]$procId; process = [string]$p.ProcessName; app = [string]$desc } | ConvertTo-Json -Compress))
}
`;

let shell: ChildProcessWithoutNullStreams | null = null;
let buffer = "";
const waiting: ((value: ActiveWindow | null) => void)[] = [];

function start(): void {
  if (process.platform !== "win32" || shell) return;
  const scriptPath = join(tmpdir(), "oncall-copilot-foreground.ps1");
  writeFileSync(scriptPath, SCRIPT, "utf-8");
  shell = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    windowsHide: true,
  });
  shell.stdout.setEncoding("utf-8");
  shell.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("{")) {
        const resolve = waiting.shift();
        try {
          const parsed = JSON.parse(line) as ActiveWindow;
          // pid 0 ("Idle") means no window has focus, which is not an application.
          resolve?.(parsed.pid > 0 && parsed.process !== "Idle" ? parsed : null);
        } catch {
          resolve?.(null);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  shell.on("exit", () => {
    shell = null;
    while (waiting.length) waiting.shift()?.(null);
  });
}

export function warmUp(): void {
  start();
}

/** The window the engineer was looking at, or null when unavailable (non-Windows, or no answer within the timeout). */
export function foregroundWindow(timeoutMs = 400): Promise<ActiveWindow | null> {
  start();
  if (!shell) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: ActiveWindow | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    waiting.push(done);
    shell?.stdin.write("query\n");
    setTimeout(() => {
      const index = waiting.indexOf(done);
      if (index !== -1) waiting.splice(index, 1);
      done(null);
    }, timeoutMs);
  });
}

export function stop(): void {
  shell?.kill();
  shell = null;
}
