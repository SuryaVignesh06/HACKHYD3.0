// On-Call Copilot desktop shell: the console window, the global-shortcut overlay, and the few native
// capabilities the web UI cannot have (active window, clipboard, screen capture, folder consent, open in editor).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrowserWindow,
  app,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  shell,
} from "electron";
import { foregroundWindow, stop as stopForeground, warmUp } from "./activeWindow";
import { config } from "./env";

const COMPACT = { width: 500, height: 600 };
const EXPANDED = { width: 540, height: 860 };
const UNSAFE_PATH = /["&|<>^%!\r\n]/;

let mainWindow: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let shortcutRegistered = false;
let expanded = false;
let quitting = false;

function preload(): string {
  return join(__dirname, "preload.js");
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#0B0D10",
    title: "On-Call Copilot",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: preload(), contextIsolation: true, sandbox: true },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  void mainWindow.loadURL(config.frontendUrl);
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
}

function createOverlay(): void {
  overlay = new BrowserWindow({
    ...COMPACT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: "#00000000",
    title: "On-Call Copilot",
    webPreferences: { preload: preload(), contextIsolation: true, sandbox: true },
  });
  overlay.setAlwaysOnTop(true, "floating");
  overlay.setVisibleOnAllWorkspaces(true);
  // The overlay deliberately stays open on blur, so the engineer can switch to the editor to apply the fix.
  void overlay.loadURL(`${config.frontendUrl}/overlay`);
}

function placeOverlay(): void {
  if (!overlay) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const size = expanded ? EXPANDED : COMPACT;
  const height = Math.min(size.height, display.workArea.height - 48);
  overlay.setBounds({
    x: display.workArea.x + display.workArea.width - size.width - 24,
    y: display.workArea.y + 24,
    width: size.width,
    height,
  });
}

async function activate(): Promise<void> {
  if (!overlay) return;
  if (overlay.isVisible() && overlay.isFocused()) {
    overlay.hide();
    return;
  }
  const started = Date.now();
  // Read the foreground window before the overlay takes focus.
  const window = await foregroundWindow(300);
  const text = clipboard.readText().slice(0, 6000);
  placeOverlay();
  overlay.show();
  overlay.focus();
  const openedInMs = Date.now() - started;
  overlay.webContents.send("copilot:activated", { window, clipboard: text, at: new Date().toISOString(), openedInMs });
  console.log(`On-Call Copilot: overlay opened in ${openedInMs} ms (foreground: ${window ? `${window.process} "${window.title}"` : "unknown"})`);
  if (config.captureDir) scheduleSelfTestCaptures();
}

/** Only when ONCALL_SELFTEST_DIR is set: saves the overlay's own pixels so the flow can be verified headlessly. */
function scheduleSelfTestCaptures(): void {
  mkdirSync(config.captureDir, { recursive: true });
  for (const delay of [1500, 8000, 20000, 40000, 60000]) {
    setTimeout(() => {
      void overlay?.webContents.capturePage().then((image) => {
        writeFileSync(join(config.captureDir, `overlay-${delay}.png`), image.toPNG());
      });
    }, delay);
  }
}

function registerShortcut(): void {
  shortcutRegistered = globalShortcut.register(config.shortcut, () => void activate());
  console.log(shortcutRegistered ? `On-Call Copilot: ${config.shortcut} registered` : `On-Call Copilot: ${config.shortcut} is taken by another app`);
}

async function api<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${config.apiBase}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-OnCall-Client": "desktop", ...(init?.headers ?? {}) },
    });
    const body = (await response.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!response.ok) return { ok: false, message: body?.message ?? `Backend returned ${response.status}.` };
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, message: `The agent backend is not reachable at ${config.apiBase}.` };
  }
}

async function chooseProject(): Promise<unknown> {
  const parent = (overlay?.isVisible() ? overlay : mainWindow) ?? undefined;
  const picked = parent
    ? await dialog.showOpenDialog(parent, { title: "Choose the project On-Call Copilot may inspect", properties: ["openDirectory"] })
    : await dialog.showOpenDialog({ title: "Choose the project On-Call Copilot may inspect", properties: ["openDirectory"] });
  const folder = picked.filePaths[0];
  if (picked.canceled || !folder) return { cancelled: true };
  const options = {
    type: "question" as const,
    title: "Project access",
    message: `On-Call Copilot wants to inspect:\n${folder}`,
    detail:
      "This allows the agent to read source files, configuration, logs and the project structure inside this folder only. " +
      "It never writes to the folder and never reads outside it.",
    buttons: ["Allow once", "Always allow for this project", "Cancel"],
    defaultId: 1,
    cancelId: 2,
    noLink: true,
  };
  const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  if (answer.response === 2) return { cancelled: true };
  const result = await api<unknown>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ root_path: folder, scope: answer.response === 0 ? "once" : "always" }),
  });
  return result.ok ? { project: result.data } : { error: result.message };
}

async function openFile(path: string, line: number): Promise<{ ok: boolean; via: string; message: string }> {
  const owner = await api<{ id: number }>(`/api/projects/resolve-path?path=${encodeURIComponent(path)}`);
  if (!owner.ok) return { ok: false, via: "none", message: "That file is not inside a connected project, so it was not opened." };
  if (!UNSAFE_PATH.test(path)) {
    const opened = await new Promise<boolean>((resolve) => {
      const child = spawn("code", ["-g", `"${path}:${Math.max(1, Math.floor(line))}"`], { shell: true, windowsHide: true });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
    if (opened) return { ok: true, via: "vscode", message: `Opened in VS Code at line ${line}.` };
  }
  const error = await shell.openPath(path);
  return error
    ? { ok: false, via: "none", message: error }
    : { ok: true, via: "default-app", message: "Opened with the default app (VS Code was not available, so the line is not selected)." };
}

async function captureScreen(): Promise<{ ok: boolean; dataUrl?: string; message?: string }> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wasVisible = overlay?.isVisible() ?? false;
  overlay?.hide();
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    const width = 1600;
    const height = Math.round((display.size.height / display.size.width) * width);
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source) return { ok: false, message: "No screen was available to capture." };
    return { ok: true, dataUrl: source.thumbnail.toDataURL() };
  } catch {
    return { ok: false, message: "Screen capture was blocked by the operating system." };
  } finally {
    if (wasVisible) {
      overlay?.show();
      overlay?.focus();
    }
  }
}

async function removeOnceProjects(): Promise<void> {
  const projects = await api<{ id: number; scope: string }[]>("/api/projects");
  if (!projects.ok) return;
  await Promise.all(
    projects.data.filter((p) => p.scope === "once").map((p) => api(`/api/projects/${p.id}`, { method: "DELETE" })),
  );
}

ipcMain.on("copilot:config", (event) => {
  event.returnValue = { shortcut: config.shortcut, shortcutRegistered, apiBase: config.apiBase };
});
ipcMain.on("copilot:hide", () => overlay?.hide());
ipcMain.on("copilot:set-expanded", (_event, value: boolean) => {
  expanded = Boolean(value);
  placeOverlay();
});
ipcMain.on("copilot:open-console", (_event, route: string) => {
  if (!mainWindow) return;
  if (typeof route === "string" && route.startsWith("/")) void mainWindow.loadURL(`${config.frontendUrl}${route}`);
  mainWindow.show();
  mainWindow.focus();
});
ipcMain.handle("copilot:choose-project", () => chooseProject());
ipcMain.handle("copilot:open-file", (_event, path: string, line: number) =>
  typeof path === "string" && typeof line === "number" ? openFile(path, line) : { ok: false, via: "none", message: "Invalid request." },
);
ipcMain.handle("copilot:capture-screen", () => captureScreen());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  void app.whenReady().then(() => {
    warmUp();
    createMainWindow();
    createOverlay();
    registerShortcut();
    // Self-test only: run the exact shortcut handler once, since synthetic key presses from a
    // background process do not reach the interactive desktop's hotkey handler.
    if (config.captureDir) setTimeout(() => void activate(), 6000);
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    globalShortcut.unregisterAll();
    stopForeground();
    void removeOnceProjects().finally(() => app.exit(0));
  });
  app.on("window-all-closed", () => app.quit());
}
