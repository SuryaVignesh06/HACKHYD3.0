// On-Call Copilot desktop shell: the console window, the global-shortcut overlay, and the few native
// capabilities the web UI cannot have (active window, clipboard, screen capture, folder consent, open in editor).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  BrowserWindow,
  app,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  shell,
} from "electron";
import { foregroundWindow, stop as stopForeground, warmUp } from "./activeWindow";
import { config } from "./env";
import { startServices, stopServices } from "./serverManager";
import { detectIde } from "./ide";
import { readScreen } from "./screenRead";
import { SPLASH_HTML } from "./splash";
import { startVoice, stopVoice, voiceSupported } from "./voice";

const FADE_IN_MS = 140;
const FADE_OUT_MS = 110;
const UNSAFE_PATH = /["&|<>^%!\r\n]/;

let mainWindow: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let activeShortcut = config.shortcut;
let shortcutRegistered = false;
let fadeTimer: NodeJS.Timeout | null = null;
let quitting = false;

function preload(): string {
  return join(__dirname, "preload.js");
}

const OVERLAY_WIDTH = 480;
const OVERLAY_HEIGHT = 700;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#101010",
    title: "On-Call Copilot",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: preload(), contextIsolation: true, sandbox: true },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.on("did-finish-load", () => broadcastShortcutStatus());
  void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
}

function createOverlay(): void {
  const display = screen.getPrimaryDisplay();
  const x = Math.round(display.bounds.x + (display.bounds.width - OVERLAY_WIDTH) / 2);
  const y = Math.round(display.bounds.y + (display.bounds.height - OVERLAY_HEIGHT) / 2.3);

  overlay = new BrowserWindow({
    // Siri-like hovering card: sized strictly to the card so Windows acrylic blurs ONLY
    // the region directly behind the card, leaving the rest of the desktop sharp and visible.
    x,
    y,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    frame: false,
    transparent: true,
    backgroundMaterial: "acrylic",
    hasShadow: true,
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
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true);
  overlay.webContents.on("did-finish-load", () => broadcastShortcutStatus());
  // The overlay is created before the frontend is up, so a failed load is retried until the page arrives.
  overlay.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    // -3 is ERR_ABORTED: a newer navigation replaced this one, so there is nothing to retry.
    if (isMainFrame && code !== -3) setTimeout(() => loadOverlayPage(), 1000);
  });
  // Siri-like dismissal: clicking outside the card anywhere on the desktop dismisses the overlay.
  overlay.on("blur", () => {
    if (overlay && overlay.isVisible()) {
      overlay.webContents.send("copilot:dismiss");
    }
  });

  loadOverlayPage();
}

function loadOverlayPage(): void {
  if (!overlay || overlay.isDestroyed()) return;
  void overlay.loadURL(`${config.frontendUrl}/overlay`).catch(() => {});
}

function placeOverlay(): void {
  if (!overlay) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const x = Math.round(display.bounds.x + (display.bounds.width - OVERLAY_WIDTH) / 2);
  const y = Math.round(display.bounds.y + (display.bounds.height - OVERLAY_HEIGHT) / 2.3);
  overlay.setBounds({ x, y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
}

/** Window-level fade, so the blurred backdrop eases in and out with the card. */
function fade(win: BrowserWindow, to: number, ms: number, done?: () => void): void {
  if (fadeTimer) clearInterval(fadeTimer);
  const from = win.getOpacity();
  const started = Date.now();
  fadeTimer = setInterval(() => {
    const t = Math.min(1, (Date.now() - started) / ms);
    if (!win.isDestroyed()) win.setOpacity(from + (to - from) * t);
    if (t >= 1) {
      if (fadeTimer) clearInterval(fadeTimer);
      fadeTimer = null;
      done?.();
    }
  }, 16);
}

function hideOverlay(): void {
  stopVoice();
  if (!overlay || !overlay.isVisible()) return;
  const win = overlay;
  fade(win, 0, FADE_OUT_MS, () => {
    win.hide();
    win.setOpacity(1);
  });
}

async function activate(): Promise<void> {
  if (!overlay) return;
  if (overlay.isVisible() && overlay.isFocused()) {
    // Let the card play its close animation first; the renderer hides the window when it finishes.
    overlay.webContents.send("copilot:dismiss");
    return;
  }
  const started = Date.now();
  // Read the foreground window before the overlay takes focus.
  const window = await foregroundWindow(300);
  const ide = detectIde(window);
  const text = clipboard.readText().slice(0, 6000);
  placeOverlay();
  overlay.setOpacity(0);
  overlay.show();
  overlay.focus();
  fade(overlay, 1, FADE_IN_MS);
  const openedInMs = Date.now() - started;
  overlay.webContents.send("copilot:activated", { window, ide, clipboard: text, at: new Date().toISOString(), openedInMs });
  console.log(
    `On-Call Copilot: overlay opened in ${openedInMs} ms (foreground: ${window ? `${window.process} "${window.title}"` : "unknown"}` +
      `${ide ? `; IDE ${ide.ide}, folder ${ide.folderPath ?? ide.folder ?? "unknown"}, file ${ide.file ?? "none"}` : ""})`,
  );
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

function broadcastShortcutStatus(): void {
  const payload = { shortcut: activeShortcut, registered: shortcutRegistered };
  try {
    mainWindow?.webContents.send("copilot:shortcut-updated", payload);
  } catch {}
  try {
    overlay?.webContents.send("copilot:shortcut-updated", payload);
  } catch {}
}

function registerShortcut(): void {
  try {
    globalShortcut.unregisterAll();
  } catch {}

  const candidates = [config.shortcut, "Control+Shift+Space", "Alt+Space"].filter(
    (s, idx, arr) => Boolean(s) && arr.indexOf(s) === idx,
  );

  for (const candidate of candidates) {
    try {
      const ok = globalShortcut.register(candidate, () => void activate());
      if (ok) {
        shortcutRegistered = true;
        activeShortcut = candidate;
        console.log(`On-Call Copilot: Registered shortcut ${candidate}`);
        broadcastShortcutStatus();
        return;
      } else {
        console.warn(`On-Call Copilot: ${candidate} is taken by another app or OS`);
      }
    } catch (e) {
      console.warn(`On-Call Copilot: Error registering ${candidate}:`, e);
    }
  }

  shortcutRegistered = false;
  activeShortcut = config.shortcut;
  console.warn("On-Call Copilot: All global shortcuts taken. Overlay is accessible via TopBar button.");
  broadcastShortcutStatus();
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

/** The native consent dialog. The backend only reads folders registered through here. */
async function consentToFolder(folder: string): Promise<unknown> {
  const parent = (overlay?.isVisible() ? overlay : mainWindow) ?? undefined;
  const options = {
    type: "question" as const,
    title: "Project access",
    message: `Allow On-Call Copilot to read this folder?\n${folder}`,
    detail:
      "The agent can read source files, configuration, logs and the project structure inside this folder only. " +
      "It never writes to the folder and never reads outside it.",
    buttons: ["Allow once", "Always allow for this project", "Don't allow"],
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

async function chooseProject(): Promise<unknown> {
  const parent = (overlay?.isVisible() ? overlay : mainWindow) ?? undefined;
  const picked = parent
    ? await dialog.showOpenDialog(parent, { title: "Choose the project On-Call Copilot may inspect", properties: ["openDirectory"] })
    : await dialog.showOpenDialog({ title: "Choose the project On-Call Copilot may inspect", properties: ["openDirectory"] });
  const folder = picked.filePaths[0];
  if (picked.canceled || !folder) return { cancelled: true };
  return consentToFolder(folder);
}

/** A folder detected from the IDE title; it must exist and still goes through the same consent dialog. */
async function authorizeFolder(folder: unknown): Promise<unknown> {
  if (typeof folder !== "string" || !isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) {
    return { error: "That folder is not available." };
  }
  return consentToFolder(folder);
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

async function removeOnceProjects(): Promise<void> {
  const projects = await api<{ id: number; scope: string }[]>("/api/projects");
  if (!projects.ok) return;
  await Promise.all(
    projects.data.filter((p) => p.scope === "once").map((p) => api(`/api/projects/${p.id}`, { method: "DELETE" })),
  );
}

ipcMain.on("copilot:config", (event) => {
  event.returnValue = { shortcut: activeShortcut, shortcutRegistered, apiBase: config.apiBase, voice: voiceSupported() };
});
ipcMain.on("copilot:toggle-overlay", () => void activate());
ipcMain.on("copilot:hide", () => hideOverlay());
ipcMain.handle("copilot:voice-start", (event) =>
  startVoice((voiceEvent) => {
    if (!event.sender.isDestroyed()) event.sender.send("copilot:voice", voiceEvent);
  }),
);
ipcMain.on("copilot:voice-stop", () => stopVoice());
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
ipcMain.handle("copilot:read-screen", () => readScreen(overlay));
ipcMain.handle("copilot:authorize-folder", (_event, folder: unknown) => authorizeFolder(folder));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  void app.whenReady().then(async () => {
    warmUp();
    createMainWindow();
    // The shortcut is registered straight away, not after the services start, so Ctrl+Space works even while the
    // backend and frontend are still booting (or if their startup failed).
    createOverlay();
    registerShortcut();

    try {
      await startServices((status) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.executeJavaScript(`
          if (document.getElementById('status')) {
            document.getElementById('status').innerText = ${JSON.stringify(status)};
          }
        `).catch(() => {});
      });

      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(config.frontendUrl);
      }
      // Self-test only: run the exact shortcut handler once, since synthetic key presses from a
      // background process do not reach the interactive desktop's hotkey handler.
      if (config.captureDir) setTimeout(() => void activate(), 6000);
    } catch (err) {
      console.error("[Electron] Failed to start services:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(`
          if (document.getElementById('status')) {
            document.getElementById('status').style.color = '#EF4444';
            document.getElementById('status').innerText = 'Error: ' + ${JSON.stringify(msg)};
          }
        `).catch(() => {});
      }
    }
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    globalShortcut.unregisterAll();
    stopForeground();
    void removeOnceProjects().finally(() => {
      stopServices();
      app.exit(0);
    });
  });
  app.on("window-all-closed", () => app.quit());
}
