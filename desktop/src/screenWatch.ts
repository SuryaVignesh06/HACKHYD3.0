// "Read my screen" as a session: after the engineer says yes, FRIDAY reads the display every couple of seconds until
// they press Stop (or close the card), so it notices a new error the moment it appears and notices when it is gone.
// While the session runs, a pale blue border marks the screen and FRIDAY's own windows are excluded from capture.
import type { Display } from "electron";
import { foregroundWindow, type ActiveWindow } from "./activeWindow";
import { detectIde, type IdeContext } from "./ide";
import { readDisplay } from "./screenRead";

export interface WatchReading {
  seq: number;
  ok: boolean; // a frame was captured and read
  found: boolean;
  text: string; // error lines, most important first
  fingerprint: string | null;
  lineCount: number;
  ms: number;
  at: string;
  window: ActiveWindow | null; // the app the engineer is working in (never FRIDAY itself)
  ide: IdeContext | null;
  message?: string;
}

const INTERVAL_MS = 1800; // pause between reads; a read itself takes ~0.6-1.2 s
export const MAX_WATCH_MS = 60 * 60 * 1000; // a session ends on its own after an hour

let session: { display: Display; seq: number; started: number; stopped: boolean; timer: NodeJS.Timeout | null } | null = null;
let lastWindow: ActiveWindow | null = null;

export const isWatching = (): boolean => session !== null && !session.stopped;

function isFriday(win: ActiveWindow | null): boolean {
  return !win || win.pid === process.pid || /^electron$/i.test(win.process) || /\bFRIDAY\b/.test(win.title);
}

export function startWatch(display: Display, onReading: (reading: WatchReading) => void, onEnded: (reason: string) => void): void {
  stopWatch();
  const current = { display, seq: 0, started: Date.now(), stopped: false, timer: null as NodeJS.Timeout | null };
  session = current;

  const tick = async () => {
    if (current.stopped) return;
    if (Date.now() - current.started > MAX_WATCH_MS) {
      stopWatch();
      onEnded("Screen reading stopped after an hour. Start it again when you need it.");
      return;
    }
    const seq = ++current.seq;
    const win = await foregroundWindow(300);
    if (!isFriday(win)) lastWindow = win;
    let reading: WatchReading;
    try {
      const text = await readDisplay(current.display);
      reading = {
        seq, ok: true, found: text.errors.length > 0, text: text.errors.join("\n"), fingerprint: text.fingerprint,
        lineCount: text.lines.length, ms: text.ms, at: new Date().toISOString(), window: lastWindow, ide: detectIde(lastWindow),
      };
    } catch (exc) {
      reading = {
        seq, ok: false, found: false, text: "", fingerprint: null, lineCount: 0, ms: 0, at: new Date().toISOString(),
        window: lastWindow, ide: detectIde(lastWindow), message: exc instanceof Error ? exc.message : "FRIDAY couldn't read the current screen.",
      };
    }
    if (current.stopped) return;
    onReading(reading);
    current.timer = setTimeout(() => void tick(), INTERVAL_MS);
  };
  void tick();
}

export function stopWatch(): void {
  if (!session) return;
  session.stopped = true;
  if (session.timer) clearTimeout(session.timer);
  session = null;
}
