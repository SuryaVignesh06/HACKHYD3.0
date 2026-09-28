import { motion } from "framer-motion";
import { BrainCircuit, Loader2 } from "lucide-react";
import { dateWithAge, percent, splitMemoryText } from "../lib/format";
import type { MatchedIncident, RecalledMemory } from "../lib/types";
import { IncidentChip } from "./IncidentPeek";

const TYPE_LABEL: Record<string, string> = { world: "fact", experience: "experience", observation: "observation" };
const CITE_FLOOR = 0.75; // mirrors backend evidence.CITE_FLOOR: below this an incident is context, never evidence

export default function MemoryPanel({ state, matched, recalled, cited }: {
  state: "off" | "idle" | "searching" | "ready";
  matched: MatchedIncident[];
  recalled: RecalledMemory[];
  cited: string[];
}) {
  if (state === "off") {
    return <p className="text-sm text-muted">Memory is off. Turn it on to see what Hindsight recalls for this incident.</p>;
  }
  if (state === "idle") {
    return <p className="text-sm text-muted">Diagnose an alert to see the past incidents Hindsight recalls, and why.</p>;
  }
  if (state === "searching") {
    return (
      <p className="flex items-center gap-2 text-sm text-memory">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Searching past incidents in Hindsight...
      </p>
    );
  }
  if (matched.length === 0) {
    return <p className="text-sm text-muted">No similar incidents in memory yet. This one will be the first.</p>;
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-xs text-muted">Matched incidents, by Hindsight relevance</p>
        <ul className="space-y-1.5">
          {matched.map((m, i) => {
            const isCited = cited.includes(m.id);
            return (
              <motion.li
                key={m.id}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2, delay: i * 0.07 }}
                className={`rounded-xl border p-2.5 ${isCited ? "border-memory/40 bg-memory/10" : "glass-well"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <IncidentChip id={m.id} tone={isCited ? "memory" : "muted"} />
                  <span className={`font-mono text-xs ${m.relevance >= CITE_FLOOR ? "text-ink" : "text-muted"}`}>{percent(m.relevance)}</span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border">
                  <div
                    className={`h-full rounded-full ${isCited ? "bg-memory" : "bg-muted/60"}`}
                    style={{ width: `${Math.round(m.relevance * 100)}%` }}
                  />
                </div>
                <p className="mt-1.5 line-clamp-2 text-xs text-ink">{m.title}</p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {m.service} · {dateWithAge(m.occurred_at)}
                  {isCited ? " · cited as evidence" : m.relevance < CITE_FLOOR ? " · weak, not cited" : ""}
                </p>
              </motion.li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted">Recalled memories ({recalled.length})</p>
        <ul className="space-y-1.5">
          {recalled.map((memory, i) => {
            const { fact, meta } = splitMemoryText(memory.text);
            return (
              <motion.li
                key={`${i}-${memory.text.slice(0, 40)}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.07 }}
                className="rounded-xl glass-well p-2.5"
              >
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {memory.incident_id && <IncidentChip id={memory.incident_id} tone="muted" />}
                  <span className="flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                    <BrainCircuit className="h-3 w-3" aria-hidden="true" />
                    {TYPE_LABEL[memory.type] ?? memory.type}
                  </span>
                  <span className="text-[11px] text-muted">{dateWithAge(memory.occurred_at)}</span>
                  {memory.relevance !== null && (
                    <span className="ml-auto font-mono text-[11px] text-muted">{percent(memory.relevance)}</span>
                  )}
                </div>
                <p className="text-xs leading-5 text-ink">{fact}</p>
                {meta && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">{meta}</p>}
              </motion.li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
