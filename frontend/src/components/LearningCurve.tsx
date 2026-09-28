import { motion } from "framer-motion";
import { TrendingUp } from "lucide-react";
import { percent } from "../lib/format";
import type { LearningPoint } from "../lib/types";

/** One bar per diagnosis this session: height is confidence, the number is verified citations. */
export default function LearningCurve({ points }: { points: LearningPoint[] }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-4">
      <div className="shrink-0">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
          <TrendingUp className="h-4 w-4 text-memory" aria-hidden="true" /> Learning curve
        </p>
        <p className="text-[11px] text-muted">Confidence per diagnosis; label = verified citations</p>
      </div>
      {points.length === 0 ? (
        <p className="text-xs text-muted">No diagnoses yet this session.</p>
      ) : (
        <ol className="flex h-12 min-w-0 flex-1 items-end gap-1.5 overflow-x-auto" aria-label="Learning curve">
          {points.map((p, i) => {
            const height = Math.max(8, Math.round((p.confidence ?? 0) * 100));
            const tone = !p.memory_enabled ? "bg-muted/40" : p.strong_match ? "bg-memory" : "bg-amber-400/70";
            return (
              <li
                key={p.diagnosis_id}
                className="group relative flex h-full w-9 shrink-0 flex-col items-center justify-end"
                title={`${p.incident_id} · ${p.memory_enabled ? "with memory" : "without memory"} · confidence ${percent(p.confidence)} · ${p.cited_count} verified citations`}
              >
                <span className="mb-0.5 font-mono text-[10px] text-muted">{p.cited_count}</span>
                <motion.span
                  className={`w-full rounded-t ${tone}`}
                  initial={{ height: 0 }}
                  animate={{ height: `${height * 0.32}px` }}
                  transition={{ duration: 0.25, delay: i * 0.03 }}
                />
                <span className="mt-0.5 font-mono text-[9px] text-muted">{p.incident_id.replace("INC-", "")}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
