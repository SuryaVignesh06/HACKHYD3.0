import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { PeekProvider } from "./components/IncidentPeek";
import TopBar from "./components/TopBar";
import { api } from "./lib/api";
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

function Shell() {
  const [system, setSystem] = useState<SystemState>({ backend: "checking", backendMessage: null, stats: null, projects: [] });
  const [memoryOn, setMemoryOn] = useState(true);
  const location = useLocation();

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
    if ("project" in result || "error" in result) refreshStats();
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar
        system={system}
        memoryOn={memoryOn}
        onMemoryChange={setMemoryOn}
        showToggle={location.pathname === "/"}
        onConnectProject={desktop ? () => void connectProject() : null}
      />
      <main className="min-h-0 flex-1">
        <Routes>
          <Route path="/" element={<Console memoryOn={memoryOn} refreshStats={refreshStats} projectId={system.projects[system.projects.length - 1]?.id ?? null} />} />
          <Route path="/history" element={<History />} />
          <Route path="/incidents/:id" element={<IncidentDetail />} />
          <Route path="/patterns" element={<Patterns />} />
          <Route path="/memory" element={<Memory />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <PeekProvider>
        <Routes>
          <Route path="/overlay" element={<Overlay />} />
          <Route path="*" element={<Shell />} />
        </Routes>
      </PeekProvider>
    </BrowserRouter>
  );
}
