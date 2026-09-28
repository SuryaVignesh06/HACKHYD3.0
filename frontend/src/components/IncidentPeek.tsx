import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ExternalLink, X } from "lucide-react";
import { Link } from "react-router-dom";
import IncidentDetailView from "./IncidentDetailView";

interface PeekContextValue {
  open: (id: string) => void;
}

const PeekContext = createContext<PeekContextValue>({ open: () => undefined });

export function useIncidentPeek(): PeekContextValue {
  return useContext(PeekContext);
}

/** Incident chips open this drawer so the console keeps its state while the engineer reads history. */
export function PeekProvider({ children }: { children: ReactNode }) {
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const open = useCallback((id: string) => setIncidentId(id), []);
  const value = useMemo(() => ({ open }), [open]);

  useEffect(() => {
    if (!incidentId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIncidentId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [incidentId]);

  return (
    <PeekContext.Provider value={value}>
      {children}
      <AnimatePresence>
        {incidentId && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-black/50"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setIncidentId(null)}
            />
            <motion.aside
              role="dialog"
              aria-label={`Incident ${incidentId}`}
              className="fixed right-0 top-0 z-50 flex h-full w-full max-w-2xl flex-col border-l glass-strong"
              initial={{ x: 40, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 40, opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div className="flex items-center justify-between border-b border-border px-5 py-3">
                <span className="font-mono text-sm text-memory">{incidentId}</span>
                <div className="flex items-center gap-1">
                  <Link
                    to={`/incidents/${incidentId}`}
                    onClick={() => setIncidentId(null)}
                    className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted hover:bg-surface hover:text-ink"
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> Open page
                  </Link>
                  <button
                    type="button"
                    onClick={() => setIncidentId(null)}
                    className="rounded p-1 text-muted hover:bg-surface hover:text-ink"
                    aria-label="Close"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-5">
                <IncidentDetailView incidentId={incidentId} />
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </PeekContext.Provider>
  );
}

/** Renders text with every incident ID turned into a clickable chip. */
export function LinkedText({ text }: { text: string }) {
  const parts = text.split(/(\bINC-\d{3,}\b)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^INC-\d{3,}$/.test(part) ? <IncidentChip key={i} id={part} /> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

export function IncidentChip({ id, tone = "memory" }: { id: string; tone?: "memory" | "severity" | "success" | "muted" }) {
  const { open } = useIncidentPeek();
  const colors = {
    memory: "border-memory/40 text-memory hover:bg-memory/10",
    severity: "border-severity/40 text-severity hover:bg-severity/10",
    success: "border-success/40 text-success hover:bg-success/10",
    muted: "border-border text-muted hover:bg-surface",
  }[tone];
  return (
    <button
      type="button"
      onClick={() => open(id)}
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[11px] leading-4 transition-colors duration-150 ${colors}`}
    >
      {id}
    </button>
  );
}
