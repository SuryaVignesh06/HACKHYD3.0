import { Component, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { PlugZap, RotateCw, TriangleAlert } from "lucide-react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { PeekProvider } from "./components/IncidentPeek";
import TopBar from "./components/TopBar";
import { API_BASE, api } from "./lib/api";
import { desktop } from "./lib/desktop";
import type { MemoryStats, ProjectOut } from "./lib/types";
import Console from "./pages/Console";
import History from "./pages/History";
import IncidentDetail from "./pages/IncidentDetail";
import Memory from "./pages/Memory";
import Overlay from "./pages/Overlay";
import Patterns from "./pages/Patterns";

export interface SystemState {
  backend: "checking" | "ok" | "down";
  backendMessage: string | null;
  stats: MemoryStats | null;
  projects: ProjectOut[];
}

const PROJECT_KEY = "friday.project";

function readChosenProject(): number | null {
  try {
    const value = window.localStorage.getItem(PROJECT_KEY);
    return value ? Number(value) : null;
  } catch {
    return null;
  }
}

/** Shown instead of raw errors when the agent's backend cannot be reached. */
function Offline({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="glass w-full max-w-md space-y-4 p-7 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06]">
          <PlugZap className="h-6 w-6 text-muted" aria-hidden="true" />
        </span>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold">The agent is not reachable</h1>
          <p className="text-sm text-muted">
            FRIDAY could not connect to its backend. Nothing was lost; your memory lives in Hindsight.
          </p>
          {import.meta.env.DEV && (
            <p className="pt-1 font-mono text-[11px] text-muted">
              Expected at {API_BASE}. Start it with: uvicorn app.main:app --port 8000
            </p>
          )}
        </div>
        <button type="button" onClick={onRetry} className="btn btn-secondary">
          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
        </button>
      </div>
    </div>
  );
}

/** A render error shows a readable card with a reload button instead of a blank window. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("FRIDAY render error:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="glass-strong w-full max-w-md space-y-4 rounded-[26px] p-7 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-400/10">
            <TriangleAlert className="h-6 w-6 text-amber-300" aria-hidden="true" />
          </span>
          <div className="space-y-1.5">
            <h1 className="text-lg font-semibold">This view hit a problem</h1>
            <p className="text-sm text-muted">
              Nothing was lost. If the backend was started before the latest update, restart it so the app and the backend match.
            </p>
            {import.meta.env.DEV && <p className="break-words pt-1 font-mono text-[11px] text-muted">{error.message}</p>}
          </div>
          <button type="button" onClick={() => window.location.reload()} className="btn btn-secondary">
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> Reload
          </button>
        </div>
      </div>
    );
  }
}

function Shell() {
  const [system, setSystem] = useState<SystemState>({ backend: "checking", backendMessage: null, stats: null, projects: [] });
  const [memoryOn, setMemoryOn] = useState(true);
  const [chosenProject, setChosenProject] = useState<number | null>(readChosenProject);
  const location = useLocation();
  // The project FRIDAY inspects: the one chosen in the workspace menu, else the most recently connected.
  const projectId = system.projects.some((p) => p.id === chosenProject) ? chosenProject : system.projects[system.projects.length - 1]?.id ?? null;

  function chooseProject(id: number) {
    setChosenProject(id);
    try {
      window.localStorage.setItem(PROJECT_KEY, String(id));
    } catch {
      // Remembering the choice is a convenience; without storage the latest project is used.
    }
  }

  const refreshStats = useCallback(() => {
    void Promise.all([api.stats(), api.projects()]).then(([stats, projects]) => {
      setSystem({
        backend: stats.ok ? "ok" : "down",
        backendMessage: stats.ok ? null : stats.error.message,
        stats: stats.ok ? stats.data : null,
        projects: projects.ok ? projects.data : [],
      });
    });
  }, []);

  useEffect(() => {
    refreshStats();
    const timer = window.setInterval(refreshStats, 30000);
    return () => window.clearInterval(timer);
  }, [refreshStats]);

  async function connectProject() {
    if (!desktop) return;
    const result = await desktop.chooseProject();
    if ("project" in result) chooseProject(result.project.id);
    if ("project" in result || "error" in result) refreshStats();
  }

  return (
    <div className="flex h-full flex-col bg-[#060606]">
      <TopBar
        system={system}
        memoryOn={memoryOn}
        onMemoryChange={setMemoryOn}
        showToggle={location.pathname === "/"}
        projectId={projectId}
        onSelectProject={chooseProject}
        onConnectProject={desktop ? () => void connectProject() : null}
      />
      <main className="min-h-0 flex-1">
        {system.backend === "down" ? (
          <Offline onRetry={refreshStats} />
        ) : (
        <ErrorBoundary key={location.pathname}>
        <Routes>
          <Route path="/" element={<Console
                memoryOn={memoryOn}
                refreshStats={refreshStats}
                project={system.projects.find((p) => p.id === projectId) ?? null}
                onConnectProject={desktop ? () => void connectProject() : null}
              />} />
          <Route path="/history" element={<History />} />
          <Route path="/incidents/:id" element={<IncidentDetail />} />
          <Route path="/patterns" element={<Patterns />} />
          <Route path="/memory" element={<Memory demoTools={system.stats?.demo_tools ?? false} onChanged={refreshStats} />} />
        </Routes>
        </ErrorBoundary>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <PeekProvider>
        <Routes>
          <Route
            path="/overlay"
            element={
              <ErrorBoundary>
                <Overlay />
              </ErrorBoundary>
            }
          />
          <Route path="*" element={<Shell />} />
        </Routes>
      </PeekProvider>
    </BrowserRouter>
  );
}
