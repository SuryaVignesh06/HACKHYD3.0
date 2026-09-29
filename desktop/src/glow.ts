// The pale blue border that shows the screen is being read. A full-display, transparent, click-through window that
// never takes focus and is excluded from FRIDAY's own captures, so it can never be mistaken for screen content.
import { BrowserWindow, type Display } from "electron";

const GLOW_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
@property --a { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
.haze { position: fixed; inset: 0; box-shadow: inset 0 0 70px 10px rgba(110, 185, 255, 0.22), inset 0 0 18px 2px rgba(160, 210, 255, 0.35);
  animation: breathe 2.8s ease-in-out infinite; }
.rim { position: fixed; inset: 0; padding: 3px;
  background: conic-gradient(from var(--a), rgba(125, 211, 252, 0) 0deg, rgba(147, 197, 253, 0.95) 60deg, rgba(186, 230, 253, 0.35) 120deg,
    rgba(125, 211, 252, 0) 180deg, rgba(165, 180, 252, 0.85) 240deg, rgba(125, 211, 252, 0) 320deg);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude;
  animation: spin 5s linear infinite; filter: blur(0.6px); }
.rim.soft { padding: 10px; filter: blur(9px); opacity: 0.7; animation-duration: 7s; animation-direction: reverse; }
@keyframes spin { to { --a: 360deg; } }
@keyframes breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .haze, .rim { animation: none; } }
</style></head><body><div class="haze"></div><div class="rim soft"></div><div class="rim"></div></body></html>`;

let glow: BrowserWindow | null = null;

export function showGlow(display: Display): void {
  hideGlow();
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: "FRIDAY screen border",
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true);
  win.setContentProtection(true);
  win.once("ready-to-show", () => win.showInactive());
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(GLOW_HTML)}`);
  glow = win;
}

export function hideGlow(): void {
  if (glow && !glow.isDestroyed()) glow.destroy();
  glow = null;
}
