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
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setIncidentId(null)}
            />
            <motion.aside
              role="dialog"
              aria-label={`Incident ${incidentId}`}
              className="fixed right-2 top-2 z-50 flex h-[calc(100%-1rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[24px] glass-strong"
              initial={{ x: 40, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 40, opacity: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
            >
              <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
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
    memory: "border-memory/30 bg-memory/10 text-memory hover:bg-memory/20",
    severity: "border-severity/30 bg-severity/10 text-severity hover:bg-severity/20",
    success: "border-success/30 bg-success/10 text-success hover:bg-success/20",
    muted: "border-white/10 bg-white/[0.04] text-muted hover:bg-white/10 hover:text-ink",
  }[tone];
  return (
    <button
      type="button"
      onClick={() => open(id)}
      className={`inline-flex items-center rounded-full border px-2 py-[1px] font-mono text-[11px] leading-4 transition-colors duration-150 ${colors}`}
    >
      {id}
    </button>
  );
}
