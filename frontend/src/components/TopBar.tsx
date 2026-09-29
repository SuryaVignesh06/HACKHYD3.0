import { useEffect, useState } from "react";
import { Brain, FolderOpen, FolderPlus, History, Layers, LayoutDashboard, Network, Siren } from "lucide-react";
import { NavLink } from "react-router-dom";
import type { SystemState } from "../App";
import { API_BASE } from "../lib/api";
import { desktop, shortcutLabel } from "../lib/desktop";
import { Kbd, Switch } from "./ui";

function Dot({ tone }: { tone: "ok" | "warn" | "down" | "idle" }) {
  const color = { ok: "bg-success", warn: "bg-amber-400", down: "bg-severity", idle: "bg-muted" }[tone];
  return (
    <span className="relative inline-flex h-2 w-2" aria-hidden="true">
      {tone === "ok" && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-30 ${color}`} style={{ animationDuration: "2.4s" }} />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

/** Hindsight and project status, each reflecting a real check. */
function SystemStatus({ system, onConnectProject }: { system: SystemState; onConnectProject: (() => void) | null }) {
  const { backend, stats, projects } = system;
  const project = projects[projects.length - 1];
  const dev = import.meta.env.DEV;

  const [shortcutState, setShortcutState] = useState({
    shortcut: desktop?.shortcut ?? "Control+Space",
    registered: desktop?.shortcutRegistered ?? false,
  });

  useEffect(() => {
    if (!desktop) return;
    setShortcutState({ shortcut: desktop.shortcut, registered: desktop.shortcutRegistered });
    if (desktop.onShortcutUpdated) {
      return desktop.onShortcutUpdated((s) => setShortcutState({ shortcut: s.shortcut, registered: s.registered }));
    }
  }, []);

  const pill = "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/[0.08] bg-white/[0.035] px-2.5 py-1 text-xs text-muted transition-colors";

  return (
    <div className="flex items-center gap-2">
      <span className={pill} title={dev ? `Backend: ${API_BASE}` : undefined}>
        <Brain className={`h-3.5 w-3.5 ${stats?.available ? "text-memory" : ""}`} aria-hidden="true" />
        <Dot tone={backend === "down" ? "down" : !stats ? "idle" : stats.available ? "ok" : "warn"} />
        {backend === "down" ? (
          "Agent offline"
        ) : !stats ? (
          "Connecting"
        ) : stats.available ? (
          <span>
            <span className="font-mono font-medium text-ink">{stats.memory_count}</span> <span className="hidden xl:inline">memories</span>
            {stats.observation_count !== null && (
              <span className="hidden 2xl:inline">
                {" "}· <span className="font-mono text-ink">{stats.observation_count}</span> obs
              </span>
            )}
          </span>
        ) : (
          "Memory offline"
        )}
      </span>

      {onConnectProject && (
        <button type="button" onClick={onConnectProject} className={`${pill} hover:border-white/[0.15] hover:text-ink cursor-pointer`} title={project?.root_path}>
          {project ? <FolderOpen className="h-3.5 w-3.5 text-memory" aria-hidden="true" /> : <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />}
          <span className="max-w-[110px] truncate font-mono text-[11px] text-ink">{project ? project.name : "Connect project"}</span>
        </button>
      )}

      {desktop && (
        <button
          type="button"
          onClick={() => desktop?.toggleOverlay?.()}
          className={`${pill} hover:border-memory/40 hover:text-ink cursor-pointer`}
          title={
            shortcutState.registered
              ? `Press ${shortcutLabel(shortcutState.shortcut)} anywhere to open the overlay, or click here`
              : "Shortcut taken by another app; click here to open overlay directly"
          }
        >
          <Kbd>{shortcutLabel(shortcutState.shortcut)}</Kbd>
          <span className={`text-[10px] font-medium ${shortcutState.registered ? "text-success" : "text-amber-300"}`}>
            {shortcutState.registered ? "ready" : "click to open"}
          </span>
        </button>
      )}
    </div>
  );
}

export default function TopBar({ system, memoryOn, onMemoryChange, showToggle, onConnectProject }: {
  system: SystemState;
  memoryOn: boolean;
  onMemoryChange: (value: boolean) => void;
  showToggle: boolean;
  onConnectProject: (() => void) | null;
}) {
  const link = ({ isActive }: { isActive: boolean }) => `segment ${isActive ? "segment-active" : ""}`;

  return (
    <header className="glass-bar relative z-20 flex h-[60px] shrink-0 items-center justify-between gap-3 px-5">
      {/* Brand / Title */}
      <div className="flex shrink-0 items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-severity/90 to-severity/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_4px_14px_rgba(239,68,68,0.3)]">
          <Siren className="h-4 w-4 text-white" aria-hidden="true" />
        </span>
        <div className="min-w-0 leading-tight">
          <p className="text-sm font-semibold tracking-tight text-ink">On-Call Copilot</p>
          <p className="truncate font-mono text-[10px] text-muted">{system.stats?.bank_id ?? "nimbus-oncall"}</p>
        </div>
      </div>

      {/* Navigation Tabs (Centered) */}
      <nav className="segmented mx-2 shrink-0" aria-label="Main">
        <NavLink to="/" end className={link}>
          <LayoutDashboard className="h-3.5 w-3.5" aria-hidden="true" /> Console
        </NavLink>
        <NavLink to="/history" className={link}>
          <History className="h-3.5 w-3.5" aria-hidden="true" /> History
        </NavLink>
        <NavLink to="/patterns" className={link}>
          <Layers className="h-3.5 w-3.5" aria-hidden="true" /> Patterns
        </NavLink>
        <NavLink to="/memory" className={link}>
          <Network className="h-3.5 w-3.5" aria-hidden="true" /> Memory
        </NavLink>
      </nav>

      {/* Status Badges & Memory Toggle */}
      <div className="flex shrink-0 items-center gap-2">
        <SystemStatus system={system} onConnectProject={onConnectProject} />
        {showToggle && (
          <label className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-white/[0.08] bg-white/[0.035] py-1 pl-3 pr-1 text-xs">
            <span className={memoryOn ? "text-memory font-medium" : "text-muted"}>Memory</span>
            <Switch on={memoryOn} onChange={onMemoryChange} label="Use Hindsight memory" />
          </label>
        )}
      </div>
    </header>
  );
}
