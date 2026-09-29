import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  Ban,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  FileCode2,
  Loader2,
  Network,
  RotateCcw,
  Server,
  Sparkles,
  DatabaseZap,
  TriangleAlert,
} from "lucide-react";
import { IncidentChip } from "../components/IncidentPeek";
import { Stat } from "../components/ui";
import { api } from "../lib/api";
import { dateTime, dateWithAge, shortDate } from "../lib/format";
import type { ApiError, FamilyNode, FixOutcome, MemoryEvent, MemoryOverview, ServiceNode } from "../lib/types";

type Selection = { kind: "service"; service: string } | { kind: "family"; service: string; family: string };

/** Development tools. The backend refuses both when DEMO_TOOLS=false, and the buttons are hidden then too. */
function DemoTools({ onChanged }: { onChanged: () => void }) {
  const [stage, setStage] = useState<"idle" | "confirm" | "seeding" | "resetting" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function seed() {
    setStage("seeding");
    const result = await api.seedMemory();
    if (result.ok) {
      const r = result.data;
      setStage("done");
      setMessage(
        r.status === "already_seeded"
          ? `Already seeded: all ${r.skipped} historical incidents are in ${r.bank}. Nothing was duplicated.`
          : `Seeded ${r.bank}: ${r.created} experiences created, ${r.skipped} already present${r.memory_count !== null ? `; the bank now holds ${r.memory_count} memories` : ""}.`,
      );
      onChanged();
    } else {
      setStage("error");
      setMessage(result.error.message);
    }
  }

  async function reset() {
    setStage("resetting");
    const result = await api.resetDemo();
    if (result.ok) {
      setStage("done");
      setMessage(`Reset complete: ${result.data.memories} memories reseeded, ${result.data.live_incidents_removed} live incidents removed. Reload to see the fresh state.`);
      onChanged();
    } else {
      setStage("error");
      setMessage(result.error.message);
    }
  }

  const busy = stage === "seeding" || stage === "resetting";
  return (
    <div className="flex max-w-xl flex-col items-end gap-2 text-xs">
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => void seed()} className="btn btn-primary">
          {stage === "seeding" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <DatabaseZap className="h-3.5 w-3.5" aria-hidden="true" />}
          {stage === "seeding" ? "Seeding Hindsight..." : "Seed engineering memory"}
        </button>
        {stage === "confirm" ? (
          <>
            <button type="button" onClick={() => void reset()} className="btn btn-danger">
              Confirm reset
            </button>
            <button type="button" onClick={() => setStage("idle")} className="btn btn-ghost">
              Cancel
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => setStage("confirm")} className="btn btn-secondary">
            {stage === "resetting" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
            {stage === "resetting" ? "Resetting..." : "Reset demo memory"}
          </button>
        )}
      </div>
      {stage === "confirm" && (
        <p className="text-right text-muted">
          Deletes and reseeds the Hindsight bank with the 45 historical incidents (about a minute), removes incidents created during the demo and restores the demo
          project config. Connected projects are kept.
        </p>
      )}
      {(stage === "done" || stage === "error") && <p className={`text-right ${stage === "done" ? "text-success" : "text-severity"}`}>{message}</p>}
      <p className="text-[10px] uppercase tracking-[0.08em] text-muted/70">Development tools</p>
    </div>
  );
}

/** Single series (cumulative incidents learned), one axis, 2px line, crosshair tooltip on hover. */
function GrowthChart({ points }: { points: MemoryOverview["growth"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const height = 150;
  const pad = { left: 36, right: 12, top: 10, bottom: 22 };
  if (points.length < 2) return <p className="text-xs text-muted">Not enough resolved incidents to draw growth yet.</p>;
  const t0 = new Date(points[0]!.at).getTime();
  const t1 = new Date(points[points.length - 1]!.at).getTime();
  const maxY = points[points.length - 1]!.incidents_learned;
  const x = (at: string) => pad.left + ((new Date(at).getTime() - t0) / Math.max(1, t1 - t0)) * (width - pad.left - pad.right);
  const y = (v: number) => height - pad.bottom - (v / maxY) * (height - pad.top - pad.bottom);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.at).toFixed(1)},${y(p.incidents_learned).toFixed(1)}`).join(" ");
  const ticks = [0, Math.round(maxY / 2), maxY];
  const active = hover === null ? null : points[hover];

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.at) - px) < Math.abs(x(points[best]!.at) - px)) best = i;
    });
    setHover(best);
  }

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full" role="img" aria-label={`Incidents learned grew to ${maxY}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
            <text x={pad.left - 6} y={y(t) + 3} textAnchor="end" className="fill-muted font-mono text-[10px]">
              {t}
            </text>
          </g>
        ))}
        <text x={pad.left} y={height - 6} className="fill-muted text-[10px]">
          {shortDate(points[0]!.at)}
        </text>
        <text x={width - pad.right} y={height - 6} textAnchor="end" className="fill-muted text-[10px]">
          {shortDate(points[points.length - 1]!.at)}
        </text>
        <path d={path} fill="none" className="stroke-memory" strokeWidth={2} strokeLinejoin="round" />
        {active && (
          <>
            <line x1={x(active.at)} x2={x(active.at)} y1={pad.top} y2={height - pad.bottom} className="stroke-muted/50" strokeWidth={1} />
            <circle cx={x(active.at)} cy={y(active.incidents_learned)} r={4.5} className="fill-memory stroke-bg" strokeWidth={2} />
          </>
        )}
        <rect x={pad.left} y={0} width={width - pad.left - pad.right} height={height} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {active && (
        <div
          className="pointer-events-none absolute top-0 rounded-lg glass-strong px-2.5 py-1.5 text-[11px]"
          style={{ left: `min(calc(${(x(active.at) / width) * 100}% + 8px), calc(100% - 170px))` }}
        >
          <p className="text-muted">{dateTime(active.at)}</p>
          <p className="text-ink">
            <span className="font-mono">{active.incidents_learned}</span> incidents learned
          </p>
          <p className="text-muted">
            <span className="font-mono">{active.fixes_recorded}</span> fix outcomes recorded
          </p>
        </div>
      )}
    </div>
  );
}

function Outcomes({ items, kind }: { items: FixOutcome[]; kind: "worked" | "failed" }) {
  if (items.length === 0) return <p className="text-xs text-muted">none recorded</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={`${item.incident_id}-${item.action}`} className="flex items-start gap-2 text-xs">
          {kind === "worked" ? (
            <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
          ) : (
            <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-severity" aria-hidden="true" />
          )}
          <span className="flex-1 text-ink">{item.action}</span>
          <IncidentChip id={item.incident_id} tone={kind === "worked" ? "success" : "severity"} />
        </li>
      ))}
    </ul>
  );
}

function FamilyDetail({ family, service }: { family: FamilyNode; service: string }) {
  return (
    <div className="space-y-5">
      <div>
        <p className="font-mono text-[11px] text-muted">{service}</p>
        <h2 className="text-base font-semibold text-ink">{family.label}</h2>
        <p className="mt-1 text-xs text-muted">
          {family.incident_ids.length} incidents · first {family.first_seen ? dateWithAge(family.first_seen) : "n/a"} · last{" "}
          {family.last_seen ? dateWithAge(family.last_seen) : "n/a"}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {family.incident_ids.map((id) => (
            <IncidentChip key={id} id={id} />
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-success">Worked ({family.worked.length})</p>
          <Outcomes items={family.worked} kind="worked" />
        </div>
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-severity">Failed ({family.failed.length})</p>
          <Outcomes items={family.failed} kind="failed" />
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-300">Related files</p>
        {family.related_files.length === 0 ? (
          <p className="text-xs text-muted">None yet. The desktop agent records the files it finds when it investigates this failure in a connected project.</p>
        ) : (
          family.related_files.map((file) => (
            <p key={file} className="flex items-center gap-1.5 font-mono text-xs text-ink">
              <FileCode2 className="h-3.5 w-3.5 text-muted" aria-hidden="true" /> {file}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function ServiceDetail({ node }: { node: ServiceNode }) {
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-ink">{node.service}</h2>
      <p className="text-xs text-muted">
        {node.incident_count} resolved incidents: {node.families.length} recurring failure patterns and {node.other_incident_ids.length} one-offs.
      </p>
      {node.families.map((f) => (
        <p key={f.family} className="text-xs text-ink">
          {f.label}: {f.incident_ids.length} incidents, {f.worked.length} fixes worked, {f.failed.length} failed
        </p>
      ))}
      {node.other_incident_ids.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {node.other_incident_ids.map((id) => (
            <IncidentChip key={id} id={id} tone="muted" />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Memory({ demoTools, onChanged }: { demoTools: boolean; onChanged: () => void }) {
  const [data, setData] = useState<MemoryOverview | null>(null);
  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({ "payments-api": true });
  const [selection, setSelection] = useState<Selection>({ kind: "family", service: "payments-api", family: "redis-pool-exhaustion" });

  useEffect(() => {
    void api.memoryOverview().then((r) => (r.ok ? setData(r.data) : setError(r.error)));
    void api.memoryEvents(12).then((r) => r.ok && setEvents(r.data));
  }, []);

  const selected = useMemo(() => {
    const service = data?.services.find((s) => s.service === selection.service);
    if (!service) return null;
    if (selection.kind === "service") return { kind: "service" as const, service };
    const family = service.families.find((f) => f.family === selection.family);
    return family ? { kind: "family" as const, service, family } : { kind: "service" as const, service };
  }, [data, selection]);

  if (error) return <p className="p-6 text-sm text-severity">{error.message}</p>;
  if (!data) {
    return (
      <p className="flex items-center gap-2 p-6 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading team memory...
      </p>
    );
  }
  const t = data.totals;

  return (
    <div className="h-full overflow-y-auto px-6 py-7">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow flex items-center gap-1.5 !text-memory">
              <Network className="h-3.5 w-3.5" aria-hidden="true" /> Engineering memory
            </p>
            <h1 className="mt-1 text-2xl font-semibold">Nimbus Pay</h1>
            <p className="mt-1 max-w-xl text-sm text-muted">What the team has learned, grouped by service and recurring failure. Every number comes from recorded incidents and the Hindsight bank.</p>
          </div>
          {demoTools && <DemoTools onChanged={onChanged} />}
        </div>

        <section className="glass grid grid-cols-2 gap-x-6 gap-y-5 p-6 sm:grid-cols-4 xl:grid-cols-7">
          <Stat label="Experiences" value={t.incidents_learned} hint="Resolved incidents retained as engineering experience" />
          <Stat label="Incident families" value={t.families} />
          <Stat label="Successful fixes" value={t.worked} tone="text-success" />
          <Stat label="Failed approaches" value={t.failed} tone="text-severity" />
          <Stat label="Outcomes recorded" value={t.fix_attempts} />
          <Stat label="Learned live" value={t.live_incidents_learned} tone="text-memory" />
          <Stat label="Hindsight memories" value={t.hindsight_memories ?? "n/a"} tone="text-memory" hint="Memory units in the bank, from Hindsight" />
        </section>

        <section className="glass p-5">
          <p className="eyebrow mb-3 flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-memory" aria-hidden="true" /> Recently learned experiences
          </p>
          {(data.recent_learned ?? []).length === 0 ? (
            <p className="text-sm text-muted">None yet. Resolve an incident with "Resolve and learn" and it appears here.</p>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {(data.recent_learned ?? []).map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                  <IncidentChip id={e.id} />
                  <span className="min-w-0 flex-1 truncate text-ink" title={e.root_cause ?? undefined}>
                    {e.root_cause ?? e.title}
                  </span>
                  <span className="text-xs text-success">{e.worked} worked</span>
                  <span className="text-xs text-severity">{e.failed} failed</span>
                  <span className="text-xs text-muted">{e.resolved_at ? dateWithAge(e.resolved_at) : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="glass p-5">
          <p className="eyebrow mb-2">Experience growth: incidents learned</p>
          <GrowthChart points={data.growth} />
        </section>

        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <section className="glass p-4">
            <p className="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-ink">
              <BrainCircuit className="h-4 w-4 text-memory" aria-hidden="true" /> Nimbus Pay
            </p>
            <ul className="space-y-0.5">
              {data.services.map((service) => (
                <li key={service.service}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen((o) => ({ ...o, [service.service]: !o[service.service] }));
                      setSelection({ kind: "service", service: service.service });
                    }}
                    className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-white/[0.05] ${selection.kind === "service" && selection.service === service.service ? "bg-white/[0.07] text-ink" : "text-ink"}`}
                  >
                    {open[service.service] ? <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden="true" />}
                    <Server className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                    <span className="font-mono">{service.service}</span>
                    <span className="ml-auto font-mono text-[10px] text-muted">{service.incident_count}</span>
                  </button>
                  {open[service.service] && (
                    <ul className="ml-5 border-l border-border pl-2">
                      {service.families.map((family) => {
                        const active = selection.kind === "family" && selection.family === family.family && selection.service === service.service;
                        return (
                          <li key={family.family}>
                            <button
                              type="button"
                              onClick={() => setSelection({ kind: "family", service: service.service, family: family.family })}
                              className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs ${active ? "bg-memory/10 text-memory" : "text-muted hover:bg-white/[0.05] hover:text-ink"}`}
                            >
                              <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
                              {family.label}
                              <span className="ml-auto font-mono text-[10px]">{family.incident_ids.length}</span>
                            </button>
                          </li>
                        );
                      })}
                      {service.other_incident_ids.length > 0 && (
                        <li className="px-1.5 py-1 text-[11px] text-muted">{service.other_incident_ids.length} one-off incidents</li>
                      )}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <motion.section key={JSON.stringify(selection)} initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.18 }} className="glass p-6">
            {selected?.kind === "family" ? (
              <FamilyDetail family={selected.family} service={selected.service.service} />
            ) : selected ? (
              <ServiceDetail node={selected.service} />
            ) : (
              <p className="text-sm text-muted">Select a service or failure pattern.</p>
            )}
          </motion.section>
        </div>

        <section className="glass p-5">
          <p className="eyebrow mb-3 flex items-center gap-1.5">
            <Activity className="h-4 w-4 text-memory" aria-hidden="true" /> Hindsight activity
          </p>
          {events.length === 0 ? (
            <p className="text-xs text-muted">No memory operations yet since the last reset.</p>
          ) : (
            <ul className="space-y-1">
              {events.map((event) => (
                <li key={event.id} className="flex items-center gap-2 text-xs">
                  <span className={`w-16 shrink-0 rounded-full px-1.5 py-0.5 text-center font-mono text-[10px] uppercase ${event.ok ? "bg-memory/10 text-memory" : "bg-severity/10 text-severity"}`}>
                    {event.kind}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink">{event.detail}</span>
                  {event.count !== null && event.kind === "recall" && <span className="font-mono text-muted">{event.count} memories</span>}
                  {event.incident_id && <IncidentChip id={event.incident_id} tone="muted" />}
                  <span className="shrink-0 text-muted">{dateTime(event.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
