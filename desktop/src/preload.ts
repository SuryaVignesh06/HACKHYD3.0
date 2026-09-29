// The only bridge between the web UI and native capabilities. The renderer never gets Node or Electron access.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

let settings = ipcRenderer.sendSync("copilot:config") as { shortcut: string; shortcutRegistered: boolean; apiBase: string };
const shortcutListeners = new Set<(payload: { shortcut: string; registered: boolean }) => void>();

ipcRenderer.on("copilot:shortcut-updated", (_event, payload: { shortcut: string; registered: boolean }) => {
  settings = { ...settings, shortcut: payload.shortcut, shortcutRegistered: payload.registered };
  for (const listener of shortcutListeners) {
    try {
      listener(payload);
    } catch {}
  }
});

contextBridge.exposeInMainWorld("copilot", {
  isDesktop: true,
  get shortcut() {
    return settings.shortcut;
  },
  get shortcutRegistered() {
    return settings.shortcutRegistered;
  },
  onShortcutUpdated(callback: (payload: { shortcut: string; registered: boolean }) => void): () => void {
    shortcutListeners.add(callback);
    callback({ shortcut: settings.shortcut, registered: settings.shortcutRegistered });
    return () => shortcutListeners.delete(callback);
  },
  toggleOverlay: () => ipcRenderer.send("copilot:toggle-overlay"),
  onActivated(callback: (payload: unknown) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("copilot:activated", listener);
    return () => ipcRenderer.removeListener("copilot:activated", listener);
  },
  hide: () => ipcRenderer.send("copilot:hide"),
  setExpanded: (value: boolean) => ipcRenderer.send("copilot:set-expanded", value),
  openConsole: (route: string) => ipcRenderer.send("copilot:open-console", route),
  chooseProject: () => ipcRenderer.invoke("copilot:choose-project"),
  openFile: (path: string, line: number) => ipcRenderer.invoke("copilot:open-file", path, line),
  captureScreen: () => ipcRenderer.invoke("copilot:capture-screen"),
});

