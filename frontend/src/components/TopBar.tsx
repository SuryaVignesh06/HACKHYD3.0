// FRIDAY's top bar: the brand, the "ask anywhere" shortcut, a real status light, the Memory switch and the
// workspace menu (pages and the connected project). Every status reflects a real check.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Boxes, Check, ChevronDown, FolderPlus, History, Layers, LayoutDashboard, Network, Sparkle } from "lucide-react";
import { Link, NavLink } from "react-router-dom";
import type { SystemState } from "../App";
import { API_BASE } from "../lib/api";
import { desktop, shortcutLabel } from "../lib/desktop";
import type { ProjectOut } from "../lib/types";
import { Switch } from "./ui";

/** Asks the console's composer to take focus (used when there is no desktop overlay to open). */
export const FOCUS_COMPOSER_EVENT = "friday:focus-composer";

function useShortcut() {
  const [state, setState] = useState({ shortcut: desktop?.shortcut ?? "Control+Space", registered: desktop?.shortcutRegistered ?? false });
  useEffect(() => {
    if (!desktop?.onShortcutUpdated) return;
    return desktop.onShortcutUpdated((s) => setState({ shortcut: s.shortcut, registered: s.registered }));
  }, []);
  return state;
}

function Status({ system }: { system: SystemState }) {
  const { backend, stats } = system;
  const tone = backend === "down" ? "bg-severity" : !stats ? "bg-muted" : stats.available ? "bg-success" : "bg-amber-400";
  const label = backend === "down" ? "Offline" : !stats ? "Connecting" : stats.available ? "Ready" : "Memory offline";
  const title =
    backend === "down"
      ? `The agent's backend is not reachable${import.meta.env.DEV ? ` at ${API_BASE}` : ""}`
      : stats?.available
        ? "FRIDAY's engineering memory (Hindsight) is connected"
        : "Hindsight memory is not reachable";
  return (
    <span className="flex items-center gap-2 text-sm text-ink" title={title}>
      <span className="relative inline-flex h-2.5 w-2.5" aria-hidden="true">
        {label === "Ready" && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-40 ${tone}`} style={{ animationDuration: "2.4s" }} />}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${tone}`} />
      </span>
      {label}
    </span>
  );
}

function WorkspaceMenu({ system, projectId, onSelectProject, onConnectProject }: {
  system: SystemState;
  projectId: number | null;
  onSelectProject: (id: number) => void;
  onConnectProject: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const project = system.projects.find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const page = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${isActive ? "bg-white/[0.07] text-ink" : "text-muted hover:bg-white/[0.05] hover:text-ink"}`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink transition-colors hover:bg-white/[0.05]"
        title={project ? project.root_path : "Nimbus Pay workspace"}
      >
        <Boxes className="h-4 w-4" aria-hidden="true" />
        <span className="max-w-[160px] truncate">Nimbus Pay</span>
        {project && <span className="hidden max-w-[120px] truncate font-mono text-[11px] text-muted lg:inline">/ {project.name}</span>}
        <ChevronDown className={`h-4 w-4 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className="panel absolute right-0 top-11 z-30 w-72 !rounded-xl !bg-[#0e0e0e] p-1.5"
          >
            <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">Views</p>
            <nav onClick={() => setOpen(false)} className="space-y-0.5">
              <NavLink to="/" end className={page}>
                <LayoutDashboard className="h-4 w-4" aria-hidden="true" /> Console
              </NavLink>
              <NavLink to="/history" className={page}>
                <History className="h-4 w-4" aria-hidden="true" /> Incident history
              </NavLink>
              <NavLink to="/patterns" className={page}>
                <Layers className="h-4 w-4" aria-hidden="true" /> Patterns
              </NavLink>
              <NavLink to="/memory" className={page}>
                <Network className="h-4 w-4" aria-hidden="true" /> Memory
              </NavLink>
            </nav>
            <div className="my-1.5 h-px bg-white/[0.07]" />
            <p className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">Project FRIDAY inspects</p>
            {system.projects.length === 0 && <p className="px-3 py-1.5 text-xs text-muted">No project connected yet.</p>}
            {system.projects.map((p: ProjectOut) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={p.id === projectId}
                onClick={() => {
                  onSelectProject(p.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-white/[0.05]"
                title={p.root_path}
              >
                <span className="flex h-4 w-4 items-center justify-center">{p.id === projectId && <Check className="h-4 w-4 text-success" aria-hidden="true" />}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{p.name}</span>
                <span className="text-[10px] text-muted">{p.scope === "always" ? "always" : "this session"}</span>
              </button>
            ))}
            {onConnectProject ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onConnectProject();
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-white/[0.05] hover:text-ink"
              >
                <FolderPlus className="h-4 w-4" aria-hidden="true" /> Connect a project folder...
              </button>
            ) : (
              <p className="px-3 py-1.5 text-[11px] text-muted">Projects are connected from the desktop app, with your consent.</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function TopBar({ system, memoryOn, onMemoryChange, showToggle, projectId, onSelectProject, onConnectProject }: {
  system: SystemState;
  memoryOn: boolean;
  onMemoryChange: (value: boolean) => void;
  showToggle: boolean;
  projectId: number | null;
  onSelectProject: (id: number) => void;
  onConnectProject: (() => void) | null;
}) {
  const shortcut = useShortcut();

  function askAnywhere() {
    if (desktop?.toggleOverlay) desktop.toggleOverlay();
    else window.dispatchEvent(new Event(FOCUS_COMPOSER_EVENT));
  }

  return (
    <header className="relative z-20 grid h-[68px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-6">
      <Link to="/" className="flex items-center gap-3 justify-self-start" aria-label="FRIDAY console">
        <Sparkle className="h-6 w-6 fill-white text-white" aria-hidden="true" />
        <span className="text-[17px] font-medium tracking-[0.42em] text-ink">FRIDAY</span>
      </Link>

      <button
        type="button"
        onClick={askAnywhere}
        className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.02] py-1.5 pl-1.5 pr-5 text-sm text-muted transition-colors hover:border-white/[0.16] hover:text-ink"
        title={
          desktop
            ? shortcut.registered
              ? `Press ${shortcutLabel(shortcut.shortcut)} in any app, or click here`
              : "The shortcut is taken by another app; click here to open FRIDAY"
            : "Press / to ask FRIDAY from anywhere on the console"
        }
      >
        <span className="rounded-xl border border-white/[0.06] bg-white/[0.05] px-3 py-1 font-mono text-[13px] text-ink/90">
          {desktop ? shortcutLabel(shortcut.shortcut) : "/"}
        </span>
        {desktop ? "Ask FRIDAY anywhere" : "Ask FRIDAY"}
        {desktop && !shortcut.registered && <span className="text-[11px] text-amber-300">click to open</span>}
      </button>

      <div className="flex items-center gap-4 justify-self-end">
        {showToggle && (
          <label className="flex items-center gap-2 text-xs" title="Memory on uses Hindsight; off answers from the alert alone">
            <span className={memoryOn ? "font-medium text-ink" : "text-muted"}>Memory</span>
            <Switch on={memoryOn} onChange={onMemoryChange} label="Use Hindsight memory" />
          </label>
        )}
        <Status system={system} />
        <span className="h-6 w-px bg-white/[0.1]" aria-hidden="true" />
        <WorkspaceMenu system={system} projectId={projectId} onSelectProject={onSelectProject} onConnectProject={onConnectProject} />
      </div>
    </header>
  );
}
