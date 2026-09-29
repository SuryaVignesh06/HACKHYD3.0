// A calmer way to read a diagnosis: three tabs instead of one long scroll.
//   Fix            what to do, where, and what not to do
//   Past incidents what the team went through before, with what worked and what failed
//   Why            evidence with sources, hypotheses, unknowns and the investigation steps
import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Ban, Check, ChevronDown, CircleCheck, FileCode2, MapPin, X } from "lucide-react";
import { dateWithAge, percent } from "../lib/format";
import type { Diagnosis, PastIncident } from "../lib/types";
import { Evidence, FileActions, Remembered, RootCause, Snippet, changesOf } from "./DiagnosisSections";
import { IncidentChip } from "./IncidentPeek";
import InvestigationTimeline from "./InvestigationTimeline";

// ------------------------------------------------------------------ past incidents

/** Recalled incidents of a diagnosis, with the outcomes the verified fix log holds for them. */
export function pastFromDiagnosis(d: Diagnosis): PastIncident[] {
  return d.matched.map((m) => ({
    id: m.id,
    title: m.title ?? m.id,
    service: m.service ?? "",
    occurred_at: m.occurred_at,
    relevance: m.relevance,
    learned_live: m.learned_live,
    root_cause: null,
    fix: null,
    worked: d.worked_fixes.filter((f) => f.incident_id === m.id).map((f) => f.action),
    failed: d.failed_fixes.filter((f) => f.incident_id === m.id).map((f) => f.action),
  }));
}

function PastRow({ item, cited, index, defaultOpen }: { item: PastIncident; cited: boolean; index: number; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasDetail = item.worked.length > 0 || item.failed.length > 0 || Boolean(item.root_cause);
  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: index * 0.06 }}
      className={`overflow-hidden rounded-2xl border ${cited ? "border-memory/30 bg-memory/[0.06]" : "border-white/[0.06] bg-white/[0.025]"}`}
    >
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 px-3.5 py-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <IncidentChip id={item.id} tone={cited ? "memory" : "muted"} />
            {item.learned_live && <span className="rounded-full bg-memory/15 px-2 py-[1px] text-[10px] font-medium text-memory">learned here</span>}
            <span className="truncate text-[11px] text-muted">{dateWithAge(item.occurred_at)}</span>
          </div>
          <p className="mt-1 truncate text-[13px] text-ink">{item.title}</p>
        </div>
        {item.relevance !== null && (
          <span className="shrink-0 text-right">
            <span className="block font-mono text-xs text-ink">{percent(item.relevance)}</span>
            <span className="block text-[10px] text-muted">match</span>
          </span>
        )}
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition-transform duration-200 ${open ? "" : "-rotate-90"}`} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="space-y-2 border-t border-white/[0.06] px-3.5 py-3 text-xs">
              {item.root_cause && (
                <p className="leading-5 text-muted">
                  <span className="text-ink">Root cause: </span>
                  {item.root_cause}
                </p>
              )}
              {item.worked.map((w) => (
                <p key={w} className="flex items-start gap-2 leading-5 text-ink">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" /> {w}
                </p>
              ))}
              {item.failed.map((f) => (
                <p key={f} className="flex items-start gap-2 leading-5 text-ink">
                  <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-severity" aria-hidden="true" /> {f}
                </p>
              ))}
              {!hasDetail && (
                <p className="text-muted">
                  {cited ? "No fix outcomes recorded for this incident." : "Related, but not confirmed as the same failure, so its fixes are not suggested."}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

export function PastIncidentList({ items, cited, emptyText = "No similar incidents in memory yet. This one will be the first." }: {
  items: PastIncident[];
  cited: string[];
  emptyText?: string;
}) {
  if (items.length === 0) return <p className="py-4 text-center text-sm text-muted">{emptyText}</p>;
  const firstCited = items.findIndex((i) => cited.includes(i.id));
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <PastRow key={item.id} item={item} cited={cited.includes(item.id)} index={i} defaultOpen={i === (firstCited >= 0 ? firstCited : -1)} />
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ fix tab

function Where({ diagnosis }: { diagnosis: Diagnosis }) {
  const [code, setCode] = useState(false);
  const primary = diagnosis.findings[0];
  if (!primary) return null;
  const changes = changesOf(primary, diagnosis.worked_fixes);
  const target = [...changes].reverse().find((c) => c.worked) ?? null;
  return (
    <div className="tile-amber space-y-3">
      <p className="eyebrow flex items-center gap-1.5 !text-amber-300">
        <MapPin className="h-3.5 w-3.5" aria-hidden="true" /> Where
      </p>
      <p className="break-all font-mono text-[13px] text-ink">
        {primary.path}
        <span className="text-amber-300">:{primary.line}</span>
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div className="glass-well rounded-xl px-3 py-2">
          <p className="text-[10px] text-muted">{primary.identifier} now</p>
          <p className="font-mono text-lg text-ink">{primary.current_value ?? "not set here"}</p>
        </div>
        <div className="glass-well rounded-xl px-3 py-2">
          <p className="text-[10px] text-muted">{target ? "Worked before" : "Changed before"}</p>
          {target ? (
            <p className="flex items-center gap-2 font-mono text-lg text-success">
              {target.to} <IncidentChip id={target.incident} tone="success" />
            </p>
          ) : changes[0] ? (
            <p className="flex items-center gap-2 font-mono text-sm text-ink">
              {changes[0].from} to {changes[0].to} <IncidentChip id={changes[0].incident} tone="muted" />
            </p>
          ) : (
            <p className="text-xs text-muted">in {primary.related_incidents.join(", ")}</p>
          )}
        </div>
      </div>
      {target && primary.current_value === target.from && (
        <p className="text-xs text-amber-300">Same value as before the fix in {target.incident}.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <FileActions finding={primary} />
        <button type="button" onClick={() => setCode((v) => !v)} className="btn btn-ghost btn-sm self-start">
          <FileCode2 className="h-3.5 w-3.5" aria-hidden="true" /> {code ? "Hide code" : "Show code"}
        </button>
      </div>
      {code && <Snippet finding={primary} />}
      {diagnosis.findings.slice(1).map((f) => (
        <p key={f.path + f.line} className="text-[11px] text-muted">
          Also check <span className="font-mono text-ink">{f.identifier}{f.current_value !== null ? ` = ${f.current_value}` : ""}</span> at{" "}
          <span className="font-mono">{f.path}:{f.line}</span>
        </p>
      ))}
    </div>
  );
}

function FixTab({ diagnosis }: { diagnosis: Diagnosis }) {
  const memory = diagnosis.memory_enabled;
  const nothing = !diagnosis.try_first && diagnosis.avoid.length === 0 && diagnosis.findings.length === 0;
  return (
    <div className="space-y-3">
      <Remembered diagnosis={diagnosis} />
      {diagnosis.try_first && (
        <div className={memory ? "tile-success space-y-2" : "tile space-y-2"}>
          <p className={`eyebrow flex items-center gap-1.5 ${memory ? "!text-success" : ""}`}>
            <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" /> Do this first
          </p>
          <p className="text-[14px] leading-6 text-ink">{diagnosis.try_first.action}</p>
          {diagnosis.try_first.evidence.length > 0 && (
            <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
              Worked in
              {diagnosis.try_first.evidence.map((id) => (
                <IncidentChip key={id} id={id} tone="success" />
              ))}
            </p>
          )}
        </div>
      )}
      <Where diagnosis={diagnosis} />
      {diagnosis.avoid.length > 0 && (
        <div className={memory ? "tile-severity space-y-2.5" : "tile space-y-2.5"}>
          <p className={`eyebrow flex items-center gap-1.5 ${memory ? "!text-severity" : ""}`}>
            <Ban className="h-3.5 w-3.5" aria-hidden="true" /> Don't do this
          </p>
          {diagnosis.avoid.map((a) => (
            <div key={a.action} className="space-y-1">
              <p className="text-[13px] leading-5 text-ink">{a.action}</p>
              {a.evidence.length > 0 && (
                <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
                  Failed in
                  {a.evidence.map((id) => (
                    <IncidentChip key={id} id={id} tone="severity" />
                  ))}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {nothing && (
        <p className="py-3 text-center text-sm text-muted">
          {memory ? "No verified fix from memory for this one. See Past incidents for what is related." : "No specific fix suggested without memory."}
        </p>
      )}
    </div>
  );
}

function WhyTab({ diagnosis }: { diagnosis: Diagnosis }) {
  return (
    <div className="space-y-5">
      {diagnosis.memory_enabled && <RootCause diagnosis={diagnosis} />}
      {diagnosis.memory_enabled && <Evidence diagnosis={diagnosis} />}
      {diagnosis.unknowns.length > 0 && (
        <div className="space-y-1.5">
          <p className="eyebrow">Still unknown</p>
          <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
            {diagnosis.unknowns.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-1.5">
        <p className="eyebrow">How I got here</p>
        <InvestigationTimeline memory={diagnosis.memory_enabled} steps={diagnosis.steps} running={false} startedAt={0} matchedCount={diagnosis.matched.length} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tabs

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[] }) {
  return (
    <div className="segmented w-full" role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          onClick={() => onChange(item.value)}
          className={`segment flex-1 justify-center ${value === item.value ? "segment-active" : ""}`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

type Tab = "fix" | "past" | "why";

export default function ResultView({ diagnosis }: { diagnosis: Diagnosis }) {
  const [tab, setTab] = useState<Tab>("fix");
  const past = pastFromDiagnosis(diagnosis);
  return (
    <div className="space-y-4">
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        items={[
          { value: "fix", label: "Fix" },
          { value: "past", label: <>Past incidents{diagnosis.memory_enabled ? <span className="font-mono text-muted"> {past.length}</span> : null}</> },
          { value: "why", label: "Why" },
        ]}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16 }}>
          {tab === "fix" && <FixTab diagnosis={diagnosis} />}
          {tab === "past" &&
            (diagnosis.memory_enabled ? (
              <PastIncidentList items={past} cited={diagnosis.cited_incidents} />
            ) : (
              <p className="py-4 text-center text-sm text-muted">Memory is off, so no past incidents were recalled.</p>
            ))}
          {tab === "why" && <WhyTab diagnosis={diagnosis} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
