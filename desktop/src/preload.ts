// The only bridge between the web UI and native capabilities. The renderer never gets Node or Electron access.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

let settings = ipcRenderer.sendSync("copilot:config") as { shortcut: string; shortcutRegistered: boolean; apiBase: string; voice: boolean };
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
  onDismiss(callback: () => void): () => void {
    const listener = () => callback();
    ipcRenderer.on("copilot:dismiss", listener);
    return () => ipcRenderer.removeListener("copilot:dismiss", listener);
  },
  get voiceSupported() {
    return settings.voice;
  },
  voiceStart: () => ipcRenderer.invoke("copilot:voice-start"),
  voiceStop: () => ipcRenderer.send("copilot:voice-stop"),
  onVoice(callback: (event: unknown) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("copilot:voice", listener);
    return () => ipcRenderer.removeListener("copilot:voice", listener);
  },
  hide: () => ipcRenderer.send("copilot:hide"),
  fitOverlay: (height: number) => ipcRenderer.send("copilot:overlay-height", height),
  openConsole: (route: string) => ipcRenderer.send("copilot:open-console", route),
  chooseProject: () => ipcRenderer.invoke("copilot:choose-project"),
  openFile: (path: string, line: number) => ipcRenderer.invoke("copilot:open-file", path, line),
  watchStart: () => ipcRenderer.invoke("copilot:watch-start"),
  watchStop: () => ipcRenderer.send("copilot:watch-stop"),
  onWatch(callback: (reading: unknown) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("copilot:watch", listener);
    return () => ipcRenderer.removeListener("copilot:watch", listener);
  },
  onWatchEnded(callback: (payload: unknown) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("copilot:watch-ended", listener);
    return () => ipcRenderer.removeListener("copilot:watch-ended", listener);
  },
  onFocusComposer(callback: () => void): () => void {
    const listener = () => callback();
    ipcRenderer.on("copilot:focus-composer", listener);
    return () => ipcRenderer.removeListener("copilot:focus-composer", listener);
  },
  authorizeFolder: (folder: string) => ipcRenderer.invoke("copilot:authorize-folder", folder),
});

