import { Brain, Cpu, FolderOpen, FolderPlus, History, Keyboard, Layers, LayoutDashboard, Network, Siren } from "lucide-react";
import { NavLink } from "react-router-dom";
import type { SystemState } from "../App";
import { API_BASE } from "../lib/api";
import { desktop, shortcutLabel } from "../lib/desktop";

function MemoryToggle({ on, onChange }: { on: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted hover:bg-bg"
    >
      <span className={on ? "text-memory" : "text-muted"}>Memory</span>
      <span className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${on ? "bg-memory" : "bg-border"}`}>
        <span
          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${on ? "translate-x-4" : "translate-x-0"}`}
        />
      </span>
      <span className={`w-6 font-mono ${on ? "text-memory" : "text-muted"}`}>{on ? "ON" : "OFF"}</span>
    </button>
  );
}

function Dot({ tone }: { tone: "ok" | "warn" | "down" | "idle" }) {
  const color = { ok: "bg-success", warn: "bg-amber-400", down: "bg-severity", idle: "bg-muted" }[tone];
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} aria-hidden="true" />;
}

/** Agent, Hindsight and project status, each reflecting a real check. Details show in development builds. */
function SystemStatus({ system, onConnectProject }: { system: SystemState; onConnectProject: (() => void) | null }) {
  const { backend, stats, projects } = system;
  const project = projects[projects.length - 1];
  const dev = import.meta.env.DEV;
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="flex items-center gap-1.5 text-muted" title={dev ? `Backend: ${API_BASE}` : undefined}>
        <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
        <Dot tone={backend === "ok" ? "ok" : backend === "checking" ? "idle" : "down"} />
        {backend === "ok" ? "Agent ready" : backend === "checking" ? "Connecting..." : dev ? `Backend down (${API_BASE})` : "Agent unavailable"}
      </span>
      <span className="flex items-center gap-1.5 text-muted" title="Memories stored in the Hindsight bank">
        <Brain className={`h-3.5 w-3.5 ${stats?.available ? "text-memory" : ""}`} aria-hidden="true" />
        <Dot tone={!stats ? "idle" : stats.available ? "ok" : "warn"} />
        {!stats ? (
          "Hindsight"
        ) : stats.available ? (
          <span>
            <span className="font-mono text-ink">{stats.memory_count}</span> memories
            {stats.observation_count !== null && (
              <>
                {" "}· <span className="font-mono text-ink">{stats.observation_count}</span> observations
              </>
            )}
          </span>
        ) : (
          "Memory unavailable, degraded mode"
        )}
      </span>
      {onConnectProject &&
        (project ? (
          <button type="button" onClick={onConnectProject} className="flex items-center gap-1.5 text-muted hover:text-ink" title={project.root_path}>
            <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
            <Dot tone="ok" />
            {project.name}
          </button>
        ) : (
          <button type="button" onClick={onConnectProject} className="flex items-center gap-1.5 text-muted hover:text-ink">
            <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" /> Connect project
          </button>
        ))}
      {desktop && (
        <span
          className="flex items-center gap-1.5 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted"
          title={desktop.shortcutRegistered ? "Press anywhere to open the Copilot overlay" : "Another app owns this shortcut; set ONCALL_SHORTCUT in .env"}
        >
          <Keyboard className="h-3 w-3" aria-hidden="true" />
          {shortcutLabel(desktop.shortcut)}
          {!desktop.shortcutRegistered && <span className="text-severity">unavailable</span>}
        </span>
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
  const link = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors duration-150 ${isActive ? "bg-white/10 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]" : "text-muted hover:bg-white/5 hover:text-ink"}`;
  return (
    <header className="glass-bar relative z-10 flex h-14 shrink-0 items-center gap-4 px-5">
      <div className="flex items-center gap-2.5">
        <Siren className="h-5 w-5 text-severity" aria-hidden="true" />
        <span className="text-sm font-semibold tracking-tight">On-Call Copilot</span>
        <span className="hidden font-mono text-xs text-muted xl:inline">{system.stats?.bank_id ?? "nimbus-oncall"}</span>
      </div>
      <nav className="flex items-center gap-1">
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
      <div className="ml-auto flex items-center gap-4">
        <SystemStatus system={system} onConnectProject={onConnectProject} />
        {showToggle && <MemoryToggle on={memoryOn} onChange={onMemoryChange} />}
      </div>
    </header>
  );
}
