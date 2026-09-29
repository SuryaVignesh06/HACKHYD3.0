import { Suspense, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Radio, Sparkles } from "lucide-react";
import { desktop, shortcutLabel } from "../lib/desktop";
import { dateWithAge } from "../lib/format";
import type { MemoryOverview } from "../lib/types";
import type { DemoChoice } from "./AlertInput";
import FluidGlass from "./FluidGlass";
import { IncidentChip } from "./IncidentPeek";
import Orb, { ORB } from "./Orb";
import { Kbd, SeverityBadge } from "./ui";

export function ConsoleHero({ overview, demos, memoryOn, onDiagnose, onSimulate }: {
  overview: MemoryOverview | null;
  demos: DemoChoice[];
  memoryOn: boolean;
  onDiagnose: (demo: DemoChoice) => void;
  onSimulate: (demo: DemoChoice) => void;
}) {
  const [heroMode, setHeroMode] = useState<"fluid" | "orb">("fluid");
  const t = overview?.totals;
  const stats: [string, number | string, string][] = t
    ? [
        ["Experiences", t.incidents_learned, "text-ink"],
        ["Successful fixes", t.worked, "text-success"],
        ["Failed approaches", t.failed, "text-severity"],
        ["Learned here", t.live_incidents_learned, "text-memory"],
      ]
    : [];
  const quick = demos.filter((d) => d.signals.length > 0).slice(0, 3);

  return (
    <div className="glass flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-8 py-8 text-center">
      <div className="flex flex-col items-center">
        <div className="mb-3 flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] p-0.5 text-[11px]">
          <button
            type="button"
            onClick={() => setHeroMode("fluid")}
            className={`rounded-full px-2.5 py-0.5 transition-colors ${heroMode === "fluid" ? "bg-white/[0.14] text-ink font-medium shadow-sm" : "text-muted hover:text-ink"}`}
          >
            Fluid Glass
          </button>
          <button
            type="button"
            onClick={() => setHeroMode("orb")}
            className={`rounded-full px-2.5 py-0.5 transition-colors ${heroMode === "orb" ? "bg-white/[0.14] text-ink font-medium shadow-sm" : "text-muted hover:text-ink"}`}
          >
            Orb
          </button>
        </div>

        {heroMode === "fluid" ? (
          <div className="relative h-[150px] w-full max-w-[260px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#101010] shadow-xl shadow-black/60">
            <Suspense fallback={<div className="h-full w-full bg-[#101010] animate-pulse" />}>
              <FluidGlass
                mode="lens"
                backgroundColor="#101010"
                showContent={false}
                lensProps={{
                  scale: 0.24,
                  ior: 1.15,
                  thickness: 5,
                  chromaticAberration: 0.1,
                  anisotropy: 0.01,
                }}
              />
            </Suspense>
          </div>
        ) : (
          <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 220, damping: 16 }}>
            <Orb size={140} density={90} {...(memoryOn ? ORB.idle : ORB.off)} />
          </motion.div>
        )}
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">Ready when the pager is.</h1>
        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted">
          Paste an alert on the left or start a demo below.
          {desktop && (
            <> From any app, <span className="inline-flex items-center gap-1">press <Kbd>{shortcutLabel(desktop.shortcut)}</Kbd>.</span></>
          )}
        </p>
      </div>

      {stats.length > 0 && (
        <div className="grid w-full max-w-2xl grid-cols-4 divide-x divide-white/[0.08] rounded-2xl border border-white/[0.08] bg-white/[0.025] py-3.5 shadow-lg shadow-black/20">
          {stats.map(([label, value, tone]) => (
            <div key={label} className="px-3 transition-colors hover:bg-white/[0.02]">
              <p className={`font-mono text-2xl font-bold tracking-tight ${tone}`}>{value}</p>
              <p className="mt-1 text-xs font-medium text-muted">{label}</p>
            </div>
          ))}
        </div>
      )}

      {quick.length > 0 && (
        <div className="w-full max-w-2xl space-y-2.5 text-left">
          <p className="eyebrow">Try a demo incident</p>
          {quick.map((demo, i) => (
            <motion.div
              key={demo.key}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 + i * 0.06 }}
              className="group flex items-center justify-between gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3 transition-all hover:border-memory/40 hover:bg-white/[0.05] hover:shadow-md hover:shadow-black/20"
            >
              <div className="min-w-0 flex-1 pr-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-ink">{demo.label}</span>
                  <SeverityBadge severity={demo.severity} />
                  <span className="font-mono text-[11px] text-muted">{demo.service}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted/90">{demo.title}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => onSimulate(demo)}
                  className="btn btn-ghost btn-sm"
                  title="Replay the monitoring signals first, as if the pager fired"
                >
                  <Radio className="h-3.5 w-3.5 text-severity" aria-hidden="true" /> Simulate
                </button>
                <button type="button" onClick={() => onDiagnose(demo)} className="btn btn-secondary btn-sm">
                  Diagnose <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MemorySnapshot({ overview, memoryOn }: { overview: MemoryOverview | null; memoryOn: boolean }) {
  if (!memoryOn) return <p className="text-sm text-muted">Memory is off. Turn it on to see what Hindsight recalls for an incident.</p>;
  if (!overview) return <p className="text-sm text-muted">Loading the team's memory...</p>;
  const recent = overview.recent_learned ?? [];
  const families = (overview.services ?? [])
    .flatMap((s) => s.families.map((f) => ({ ...f, service: s.service })))
    .sort((a, b) => b.incident_ids.length - a.incident_ids.length)
    .slice(0, 5);
  const most = Math.max(1, ...families.map((f) => f.incident_ids.length));

  return (
    <div className="space-y-6">
      <p className="text-sm leading-relaxed text-muted">
        When you diagnose, the incidents Hindsight recalls appear here with their relevance. This is what memory holds now.
      </p>

      <div className="space-y-3">
        <p className="eyebrow">Recurring failures</p>
        <ul className="space-y-3">
          {families.map((f, i) => (
            <motion.li key={f.family} initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate font-medium text-ink">{f.label}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted">{f.incident_ids.length} incidents</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                <div className="h-full rounded-full bg-gradient-to-r from-memory/70 to-memory transition-all duration-300" style={{ width: `${(f.incident_ids.length / most) * 100}%` }} />
              </div>
              <p className="text-[11px] text-muted">
                <span className="font-mono text-ink/70">{f.service}</span> · <span className="text-success">{f.worked.length} worked</span> ·{" "}
                <span className="text-severity">{f.failed.length} failed</span>
              </p>
            </motion.li>
          ))}
        </ul>
      </div>

      <div className="space-y-3 pt-1">
        <p className="eyebrow flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-memory" aria-hidden="true" /> Recently learned
        </p>
        {recent.length === 0 ? (
          <p className="text-xs text-muted">Nothing learned live yet. Resolve an incident to add the first one.</p>
        ) : (
          <ul className="space-y-2">
            {recent.slice(0, 4).map((e) => (
              <li key={e.id} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3 transition-colors hover:bg-white/[0.04]">
                <div className="flex items-center gap-2">
                  <IncidentChip id={e.id} />
                  <span className="truncate text-[11px] text-muted">{e.resolved_at ? dateWithAge(e.resolved_at) : ""}</span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink">{e.root_cause ?? e.title}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
