// Which IDE, folder and file the engineer is looking at, from the foreground window title plus the IDE's own
// record of the folders it has opened. Nothing inside the folder is read here: the folder only becomes readable
// after the engineer allows it in the consent dialog.
//
// VS Code family (VS Code, Cursor, Windsurf, Antigravity, VSCodium, Trae, Kiro, Void): every opened folder has
// %APPDATA%/<app>/User/workspaceStorage/<hash>/workspace.json with its folder URI.
// JetBrains IDEs: %APPDATA%/JetBrains/<product>/options/recentProjects.xml lists project paths.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActiveWindow } from "./activeWindow";

export interface IdeContext {
  ide: string; // display name, e.g. "Cursor"
  folder: string | null; // folder name shown in the title
  folderPath: string | null; // resolved absolute path, when the IDE's records have it
  file: string | null; // file name shown in the title
}

const VSCODE_FAMILY: Record<string, { name: string; dirs: string[] }> = {
  code: { name: "VS Code", dirs: ["Code"] },
  "code - insiders": { name: "VS Code Insiders", dirs: ["Code - Insiders"] },
  cursor: { name: "Cursor", dirs: ["Cursor"] },
  windsurf: { name: "Windsurf", dirs: ["Windsurf"] },
  antigravity: { name: "Antigravity", dirs: ["Antigravity", "Antigravity IDE"] },
  "antigravity ide": { name: "Antigravity IDE", dirs: ["Antigravity IDE", "Antigravity"] },
  vscodium: { name: "VSCodium", dirs: ["VSCodium"] },
  trae: { name: "Trae", dirs: ["Trae"] },
  kiro: { name: "Kiro", dirs: ["Kiro"] },
  void: { name: "Void", dirs: ["Void"] },
};
const JETBRAINS = /^(idea|pycharm|webstorm|goland|rider|clion|phpstorm|rubymine|datagrip|rustrover|dataspell|aqua)(64)?$/i;
const APP_WORDS = /^(visual studio code|vs code|code|cursor|windsurf|antigravity( ide)?|vscodium|trae|kiro|void|intellij idea.*|pycharm.*|webstorm.*|goland.*|rider.*|clion.*|phpstorm.*|rubymine.*|datagrip.*|rustrover.*)$/i;
const FILE_LIKE = /^[^\\/:*?"<>|]+\.[A-Za-z0-9]{1,10}$/;

interface KnownFolder {
  path: string;
  modified: number;
}

let cache: { key: string; at: number; folders: KnownFolder[] } | null = null;

function appData(): string {
  return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
}

function vscodeFolders(dirs: string[]): KnownFolder[] {
  const found: KnownFolder[] = [];
  for (const dir of dirs) {
    const root = join(appData(), dir, "User", "workspaceStorage");
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      try {
        const meta = JSON.parse(readFileSync(join(root, entry, "workspace.json"), "utf-8")) as { folder?: string };
        if (!meta.folder?.startsWith("file:")) continue;
        const state = join(root, entry, "state.vscdb");
        found.push({ path: fileURLToPath(meta.folder), modified: statSync(existsSync(state) ? state : join(root, entry)).mtimeMs });
      } catch {
        // A workspace entry without a readable folder (remote, deleted or a multi-root file) is skipped.
      }
    }
  }
  return found;
}

function jetbrainsFolders(): KnownFolder[] {
  const root = join(appData(), "JetBrains");
  if (!existsSync(root)) return [];
  const found: KnownFolder[] = [];
  for (const product of readdirSync(root)) {
    const file = join(root, product, "options", "recentProjects.xml");
    if (!existsSync(file)) continue;
    const xml = readFileSync(file, "utf-8");
    const modified = statSync(file).mtimeMs;
    for (const match of xml.matchAll(/<entry key="([^"]+)"/g)) {
      const path = (match[1] ?? "").replace("$USER_HOME$", homedir()).replace(/\//g, "\\");
      if (path) found.push({ path, modified });
    }
  }
  return found;
}

function knownFolders(key: string, load: () => KnownFolder[]): KnownFolder[] {
  if (cache && cache.key === key && Date.now() - cache.at < 30_000) return cache.folders;
  const folders = load();
  cache = { key, at: Date.now(), folders };
  return folders;
}

function clean(segment: string): string {
  return segment
    .replace(/^[●*•]\s*/, "")
    .replace(/\s*\[(Administrator|SSH:[^\]]*|WSL:[^\]]*|Dev Container:[^\]]*)\]\s*$/i, "")
    .replace(/\s*\(Workspace\)\s*$/i, "")
    .trim();
}

export function detectIde(win: ActiveWindow | null): IdeContext | null {
  if (!win) return null;
  const processName = win.process.toLowerCase();
  const family = VSCODE_FAMILY[processName];
  const jetbrains = JETBRAINS.test(processName);
  if (!family && !jetbrains) return null;

  const segments = win.title.split(/\s+[-–—]\s+/).map(clean).filter((s) => s && !APP_WORDS.test(s) && s.toLowerCase() !== processName);
  const folders = family ? knownFolders(processName, () => vscodeFolders(family.dirs)) : knownFolders("jetbrains", jetbrainsFolders);

  let folder: string | null = null;
  let folderPath: string | null = null;
  for (const segment of segments) {
    const matches = folders.filter((f) => basename(f.path).toLowerCase() === segment.toLowerCase() && existsSync(f.path));
    if (matches.length) {
      folder = segment;
      folderPath = matches.sort((a, b) => b.modified - a.modified)[0]!.path;
      break;
    }
  }
  const file = segments.find((s) => s !== folder && FILE_LIKE.test(s)) ?? null;
  if (!folder) {
    // No record matched; keep the title's likely folder name so the engineer still sees what was detected.
    folder = segments.find((s) => s !== file && !FILE_LIKE.test(s) && s.length <= 80) ?? null;
  }
  return { ide: family?.name ?? (win.app || win.process), folder, folderPath, file };
}
