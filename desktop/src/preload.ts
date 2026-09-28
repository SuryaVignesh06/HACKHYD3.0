// The only bridge between the web UI and native capabilities. The renderer never gets Node or Electron access.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const settings = ipcRenderer.sendSync("copilot:config") as { shortcut: string; shortcutRegistered: boolean; apiBase: string };

contextBridge.exposeInMainWorld("copilot", {
  isDesktop: true,
  shortcut: settings.shortcut,
  shortcutRegistered: settings.shortcutRegistered,
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
