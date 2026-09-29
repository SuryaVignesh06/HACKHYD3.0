import { motion } from "framer-motion";
import { TrendingUp } from "lucide-react";
import { percent } from "../lib/format";
import type { LearningPoint } from "../lib/types";

const BAR_AREA_HEIGHT = 36; // px height of the bar track

/** One column per diagnosis: top number is verified citations, bar height is confidence, bottom is incident ID. */
export default function LearningCurve({ points }: { points: LearningPoint[] }) {
  const recent = points.slice(-18);
  const last = recent[recent.length - 1];

  return (
    <div className="flex min-w-0 flex-1 items-center gap-6">
      {/* Legend & Summary */}
      <div className="shrink-0 leading-tight">
        <p className="eyebrow flex items-center gap-1.5">
          <TrendingUp className="h-3.5 w-3.5 text-memory" aria-hidden="true" /> Learning curve
        </p>
        {last ? (
          <p className="mt-1 whitespace-nowrap text-xs text-muted">
            Latest <span className="font-mono font-medium text-ink">{last.incident_id}</span>: {percent(last.confidence)} confident, {last.cited_count} citations
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted">No diagnoses yet.</p>
        )}
        <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-xs bg-memory" /> precedent
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-xs bg-amber-400" /> no precedent
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-xs border border-white/30" /> memory off
          </span>
        </div>
      </div>

      {/* Chart Bars */}
      {recent.length > 0 && (
        <div className="relative flex min-w-0 flex-1 items-center overflow-x-auto py-1">
          <ol className="relative flex items-center gap-2" aria-label="Learning curve">
            {recent.map((p, i) => {
              const h = Math.max(4, Math.round((p.confidence ?? 0) * BAR_AREA_HEIGHT));
              const tone = !p.memory_enabled
                ? "border border-white/25 bg-white/[0.06]"
                : p.strong_match
                  ? "bg-gradient-to-t from-memory/70 to-memory shadow-[0_0_8px_rgba(20,184,166,0.3)]"
                  : "bg-gradient-to-t from-amber-400/50 to-amber-400/90";

              return (
                <li
                  key={p.diagnosis_id}
                  className="group flex w-7 shrink-0 flex-col items-center cursor-default"
                  title={`${p.incident_id} · ${p.memory_enabled ? "with memory" : "without memory"} · confidence ${percent(p.confidence)} · ${p.cited_count} verified citations`}
                >
                  {/* Top: Citations count */}
                  <span className="h-4 font-mono text-[10px] font-medium text-muted/90 group-hover:text-ink transition-colors flex items-center">
                    {p.cited_count}
                  </span>

                  {/* Middle: Bar track and animated fill */}
                  <div
                    className="relative w-full rounded-sm bg-white/[0.04] border border-white/[0.06] flex items-end justify-center p-[1px]"
                    style={{ height: BAR_AREA_HEIGHT }}
                  >
                    <motion.div
                      className={`w-full rounded-xs ${tone}`}
                      initial={{ height: 0 }}
                      animate={{ height: h }}
                      transition={{ duration: 0.35, delay: i * 0.025 }}
                    />
                  </div>

                  {/* Bottom: Incident ID */}
                  <span className="h-4 font-mono text-[9px] text-muted/70 group-hover:text-ink transition-colors flex items-center mt-0.5">
                    {p.incident_id.replace("INC-", "")}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
