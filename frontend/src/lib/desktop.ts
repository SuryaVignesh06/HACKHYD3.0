// Typed access to the Electron preload bridge. In a normal browser `desktop` is null and every
// native capability is simply absent (the UI says so rather than pretending).
import type { ProjectOut } from "./types";

export interface ActiveWindowInfo {
  title: string;
  process: string;
  app: string;
  pid: number;
}

/** The IDE, folder and file in the foreground window title, resolved against the IDE's own folder records. */
export interface IdeContext {
  ide: string;
  folder: string | null;
  folderPath: string | null;
  file: string | null;
}

/** One read of the engineer's screen during a "Read my screen" session. */
export interface WatchReading {
  seq: number;
  ok: boolean; // a frame was actually captured and read
  found: boolean;
  text: string; // error lines, most important first
  fingerprint: string | null; // the same error across frames has the same fingerprint
  lineCount: number;
  ms: number;
  at: string;
  window: ActiveWindowInfo | null;
  ide: IdeContext | null;
  message?: string;
}

export interface Activation {
  window: ActiveWindowInfo | null;
  ide?: IdeContext | null;
  clipboard: string;
  at: string;
  openedInMs: number;
}

export type VoiceEvent =
  | { type: "ready" }
  | { type: "level"; value: number }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

export type ChooseProjectResult = { project: ProjectOut } | { cancelled: true } | { error: string };

export interface CopilotBridge {
  isDesktop: true;
  shortcut: string;
  shortcutRegistered: boolean;
  toggleOverlay?(): void;
  onShortcutUpdated?(callback: (payload: { shortcut: string; registered: boolean }) => void): () => void;
  onActivated(callback: (payload: Activation) => void): () => void;
  hide(): void;
  /** Resizes the overlay window to the card, so only the card shows over the desktop. */
  fitOverlay?(height: number): void;
  onDismiss?(callback: () => void): () => void;
  voiceSupported?: boolean;
  voiceStart?(): Promise<{ ok: boolean; message: string }>;
  voiceStop?(): void;
  onVoice?(callback: (event: VoiceEvent) => void): () => void;
  openConsole(route: string): void;
  chooseProject(): Promise<ChooseProjectResult>;
  openFile(path: string, line: number): Promise<{ ok: boolean; via: string; message: string }>;
  watchStart?(): Promise<{ ok: boolean; message: string }>;
  watchStop?(): void;
  onWatch?(callback: (reading: WatchReading) => void): () => void;
  onWatchEnded?(callback: (payload: { reason: string }) => void): () => void;
  onFocusComposer?(callback: () => void): () => void;
  authorizeFolder?(folder: string): Promise<ChooseProjectResult>;
}

declare global {
  interface Window {
    copilot?: CopilotBridge;
  }
}

export const desktop: CopilotBridge | null = typeof window !== "undefined" && window.copilot ? window.copilot : null;

/** Friendly form of an Electron accelerator, e.g. "Control+Space" -> "Ctrl + Space". */
export function shortcutLabel(accelerator: string): string {
  return accelerator.replace(/Control|CommandOrControl/g, "Ctrl").split("+").join(" + ");
}

const ERROR_HINT = /(error|exception|traceback|failed|fatal|timeout|refused|denied|panic|\b[45]\d\d\b|OOMKilled|x509)/i;

/** Only clipboard text that looks like an error is used as context, and the UI always says it was used. */
export function looksLikeError(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 20 && trimmed.length <= 6000 && ERROR_HINT.test(trimmed);
}
