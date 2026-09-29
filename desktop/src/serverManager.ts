// Manages the lifecycle of both the FastAPI backend and Frontend (Vite) servers.
// If either is already running (e.g. from an external terminal during development),
// it connects to the existing instance; otherwise it spawns the subprocess and terminates
// it cleanly when the Electron application closes.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./env";

const repoRoot = join(__dirname, "..", "..");
const backendDir = join(repoRoot, "backend");
const frontendDir = join(repoRoot, "frontend");

let backendProcess: ChildProcess | null = null;
let frontendProcess: ChildProcess | null = null;
let spawnedBackend = false;
let spawnedFrontend = false;

export async function isUrlReady(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

function findPythonPath(): string {
  const isWin = process.platform === "win32";
  const candidates = isWin
    ? [
        join(backendDir, ".venv", "Scripts", "python.exe"),
        join(backendDir, "venv", "Scripts", "python.exe"),
        join(repoRoot, ".venv", "Scripts", "python.exe"),
        join(repoRoot, "venv", "Scripts", "python.exe"),
        "python.exe",
        "python",
        "py",
      ]
    : [
        join(backendDir, ".venv", "bin", "python"),
        join(backendDir, "venv", "bin", "python"),
        join(repoRoot, ".venv", "bin", "python"),
        "python3",
        "python",
      ];

  for (const candidate of candidates) {
    if (candidate.includes("\\") || candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }
  return isWin ? "python" : "python3";
}

export async function startServices(onProgress?: (status: string) => void): Promise<void> {
  const backendHealthUrl = `${config.apiBase}/docs`;
  const frontendHealthUrl = config.frontendUrl;

  const backendAlreadyUp = await isUrlReady(backendHealthUrl);
  const frontendAlreadyUp = await isUrlReady(frontendHealthUrl);

  if (backendAlreadyUp && frontendAlreadyUp) {
    console.log("[Electron] Backend and Frontend are already running.");
    onProgress?.("Services are running. Connecting...");
    return;
  }

  // 1. Start Backend if not already running
  if (!backendAlreadyUp) {
    onProgress?.("Starting backend service (FastAPI on port 8000)...");
    const pythonPath = findPythonPath();
    console.log(`[Electron] Starting backend using python at: ${pythonPath}`);

    const env = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
    };

    backendProcess = spawn(pythonPath, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"], {
      cwd: backendDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    spawnedBackend = true;

    backendProcess.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[Backend] ${line}`);
    });
    backendProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.error(`[Backend] ${line}`);
    });
    backendProcess.on("exit", (code, signal) => {
      console.log(`[Backend] Process exited (code=${code}, signal=${signal})`);
      backendProcess = null;
    });
  } else {
    console.log("[Electron] Backend is already running on port 8000.");
  }

  // 2. Start Frontend if not already running
  if (!frontendAlreadyUp) {
    onProgress?.("Starting frontend service (Vite on port 5173)...");
    const isWin = process.platform === "win32";
    const npmCmd = isWin ? "npm.cmd" : "npm";
    console.log("[Electron] Starting frontend dev server via npm run dev...");

    frontendProcess = spawn(npmCmd, ["run", "dev"], {
      cwd: frontendDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
      windowsHide: true,
    });
    spawnedFrontend = true;

    frontendProcess.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[Frontend] ${line}`);
    });
    frontendProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.error(`[Frontend] ${line}`);
    });
    frontendProcess.on("exit", (code, signal) => {
      console.log(`[Frontend] Process exited (code=${code}, signal=${signal})`);
      frontendProcess = null;
    });
  } else {
    console.log("[Electron] Frontend is already running on port 5173.");
  }

  // 3. Poll until both services are ready
  onProgress?.("Waiting for backend and frontend to be ready...");
  const startTime = Date.now();
  const maxWaitMs = 60000;

  while (Date.now() - startTime < maxWaitMs) {
    const [bUp, fUp] = await Promise.all([
      isUrlReady(backendHealthUrl),
      isUrlReady(frontendHealthUrl),
    ]);

    if (bUp && fUp) {
      console.log("[Electron] Both Backend and Frontend are ready!");
      onProgress?.("Services ready! Opening application...");
      return;
    }

    if (!bUp && !fUp) {
      onProgress?.("Waiting for backend and frontend services...");
    } else if (!bUp) {
      onProgress?.("Waiting for backend API (port 8000)...");
    } else {
      onProgress?.("Waiting for frontend UI (port 5173)...");
    }

    await new Promise((r) => setTimeout(r, 600));
  }

  throw new Error("Timed out waiting for backend and frontend services to start.");
}

function killProcessTree(pid: number): void {
  console.log(`[Electron] Terminating process tree for PID ${pid}...`);
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", pid.toString(), "/T", "/F"], { windowsHide: true });
    } catch (err) {
      console.error(`[Electron] Failed to taskkill PID ${pid}:`, err);
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
}

export function stopServices(): void {
  if (spawnedBackend && backendProcess?.pid) {
    console.log("[Electron] Stopping spawned backend service...");
    killProcessTree(backendProcess.pid);
    backendProcess = null;
    spawnedBackend = false;
  }
  if (spawnedFrontend && frontendProcess?.pid) {
    console.log("[Electron] Stopping spawned frontend service...");
    killProcessTree(frontendProcess.pid);
    frontendProcess = null;
    spawnedFrontend = false;
  }
}

// Ensure cleanup on process exit signals
process.on("exit", () => stopServices());
process.on("SIGINT", () => {
  stopServices();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopServices();
  process.exit(0);
});
