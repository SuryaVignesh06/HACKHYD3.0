// The FRIDAY incident workspace: one card per incident with the five-stage rail, then three evidence cards
// (team memory, your code, likely root cause) and a four-step "what to do next" row. Every value shown is
// derived from the streamed steps or the verified Diagnosis; stages only turn green after the real operation.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronRight,
  Code2,
  Database,
  EllipsisVertical,
  FolderPlus,
  Lightbulb,
  ListOrdered,
  Loader2,
  Minus,
  TriangleAlert,
  X,
} from "lucide-react";
import { desktop } from "../lib/desktop";
import { duration, percent, relativeAge } from "../lib/format";
import type { CodeFinding, Diagnosis, FixRecord, IncidentCreated, InvestigationStep, Outcome } from "../lib/types";
import { signatureOf } from "./DiagnosisSections";
import { IncidentChip, LinkedText } from "./IncidentPeek";

// ------------------------------------------------------------------ shared run shape

export interface WorkspaceRun {
  memory: boolean;
  steps: InvestigationStep[];
  matchedCount: number;
  findings: CodeFinding[];
  diagnosis: Diagnosis | null;
  error: string | null;
  running: boolean;
  startedAt: number;
  fix: { worked: FixRecord[]; failed: FixRecord[] } | null;
  unavailable: boolean;
}

const has = (run: WorkspaceRun, name: string) => run.steps.some((s) => s.name === name);
const stepOf = (run: WorkspaceRun, name: string) => run.steps.find((s) => s.name === name);

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

// ------------------------------------------------------------------ incident card header and stage rail

type StageState = "pending" | "active" | "done" | "skipped" | "failed";

interface Stage {
  key: string;
  label: string;
  hint: string;
  state: StageState;
  detail: string | null;
}

function stagesOf(run: WorkspaceRun, resolved: boolean, retained: boolean | null, now: number): Stage[] {
  const recallStep = stepOf(run, "recall");
  const inspectStep = stepOf(run, "inspect");
  const noProject = inspectStep?.detail.startsWith("No project connected") ?? false;
  const inspectFailed = inspectStep?.detail.startsWith("Could not read") ?? false;
  const recommendDone = Boolean(run.diagnosis);
  const active = (started: boolean): StageState => (run.running && started ? "active" : "pending");
  const reasoning = run.running && has(run, "inspect") && !recommendDone;

  return [
    {
      key: "understand",
      label: "Understand",
      hint: "Current error",
      state: has(run, "parse") ? "done" : run.error ? "failed" : active(true),
      detail: stepOf(run, "parse") ? duration(stepOf(run, "parse")!.duration_ms) : null,
    },
    {
      key: "remember",
      label: "Remember",
      hint: "Past experience",
      state: !run.memory
        ? "skipped"
        : run.unavailable
          ? "failed"
          : has(run, "evidence")
            ? "done"
            : active(has(run, "parse")),
      detail: !run.memory
        ? "Memory off"
        : run.unavailable
          ? "Hindsight unavailable"
          : recallStep
            ? `${run.matchedCount} related incident${run.matchedCount === 1 ? "" : "s"}`
            : null,
    },
    {
      key: "inspect",
      label: "Inspect",
      hint: "Your code",
      state: !run.memory || run.unavailable
        ? "skipped"
        : inspectStep
          ? noProject
            ? "skipped"
            : inspectFailed
              ? "failed"
              : "done"
          : active(has(run, "evidence")),
      detail: !run.memory || run.unavailable
        ? "Not used"
        : noProject
          ? "No project connected"
          : inspectStep
            ? run.findings.length > 0
              ? `${run.findings.length} place${run.findings.length === 1 ? "" : "s"} found`
              : inspectFailed
                ? "Could not read"
                : "Nothing matched"
            : null,
    },
    {
      key: "answer",
      label: "Answer",
      hint: "What to do",
      state: recommendDone ? (run.diagnosis?.degraded ? "failed" : "done") : run.error ? "failed" : active(run.memory ? has(run, "inspect") || run.unavailable : has(run, "parse")),
      detail: recommendDone
        ? run.diagnosis?.degraded
          ? "Plain answer"
          : `${duration(run.diagnosis!.latency_ms)}`
        : reasoning
          ? `Reasoning over ${run.matchedCount} incidents · ${duration(now - run.startedAt)}`
          : null,
    },
    {
      key: "learn",
      label: "Learn",
      hint: "From outcome",
      state: resolved ? (retained === false ? "failed" : "done") : recommendDone ? "active" : "pending",
      detail: resolved ? (retained === false ? "Not saved" : "Saved to Hindsight") : recommendDone ? "Waiting for the outcome" : null,
    },
  ];
}

function StageDot({ state }: { state: StageState }) {
  if (state === "done") {
    return (
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-success text-black shadow-[0_0_18px_rgba(53,208,111,0.35)]">
        <Check className="h-4 w-4" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  }
  if (state === "active") {
    return (
      <span className="relative flex h-9 w-9 items-center justify-center rounded-full border-2 border-success bg-black">
        <span className="absolute inset-0 animate-ping rounded-full border border-success/40" style={{ animationDuration: "1.8s" }} />
        <span className="h-3 w-3 rounded-[4px] bg-success" />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-severity/50 bg-severity/10 text-severity">
        <TriangleAlert className="h-4 w-4" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className={`flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.03] ${state === "skipped" ? "text-muted/60" : "text-muted/40"}`}>
      {state === "skipped" ? <Minus className="h-3.5 w-3.5" aria-hidden="true" /> : <span className="h-2.5 w-2.5 rounded-[3px] bg-white/25" />}
    </span>
  );
}

export function StageRail({ run, resolved, retained }: { run: WorkspaceRun; resolved: boolean; retained: boolean | null }) {
  const now = useNow(run.running);
  const stages = stagesOf(run, resolved, retained, now);
  return (
    <ol className="grid grid-cols-5 px-2" aria-label="Investigation stages">
      {stages.map((s, i) => {
        const next = stages[i + 1];
        const lineDone = s.state === "done" && next && next.state !== "pending";
        return (
          <li key={s.key} className="relative flex flex-col items-center text-center">
            {next && (
              <span className="absolute left-[calc(50%+22px)] right-[calc(-50%+22px)] top-[18px] h-[2px] overflow-hidden rounded-full bg-white/[0.08]" aria-hidden="true">
                <motion.span
                  className="block h-full bg-success"
                  initial={false}
                  animate={{ width: lineDone ? "100%" : "0%" }}
                  transition={{ duration: 0.35, ease: "easeOut" }}
                />
              </span>
            )}
            <StageDot state={s.state} />
            <p className={`mt-3 text-sm font-medium ${s.state === "pending" ? "text-muted" : "text-ink"}`}>{s.label}</p>
            <p className="mt-0.5 text-xs text-muted">{s.hint}</p>
            <p
              className={`mt-1 h-4 max-w-full truncate px-1 font-mono text-[10px] ${
                s.state === "failed" ? "text-severity" : s.state === "active" ? "text-success" : "text-muted/70"
              }`}
              title={s.detail ?? undefined}
            >
              {s.detail ?? ""}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

export interface MenuItem {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
}

function Menu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Incident actions"
        aria-expanded={open}
        className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.02] text-ink transition-colors hover:bg-white/[0.06]"
      >
        <EllipsisVertical className="h-4 w-4 rotate-90" aria-hidden="true" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            role="menu"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className="panel absolute right-0 top-11 z-20 w-64 overflow-hidden !rounded-xl !bg-[#0e0e0e] p-1"
          >
            {items.map((item) => (
              <li key={item.label}>
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="text-muted">{item.icon}</span>
                  {item.label}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

/** "RedisConnectionError" style headline from the parsed signature, falling back to the incident title. */
function headlineOf(incident: IncidentCreated, steps: InvestigationStep[]): { title: string; subtitle: string } {
  const signature = signatureOf(steps);
  if (signature) {
    const colon = signature.indexOf(":");
    if (colon > 0 && colon < 60) {
      const name = signature.slice(0, colon).split(".").pop() ?? signature.slice(0, colon);
      const rest = signature.slice(colon + 1).trim();
      return { title: name, subtitle: rest || incident.title };
    }
    return { title: signature.length > 60 ? `${signature.slice(0, 57)}...` : signature, subtitle: incident.title };
  }
  return { title: incident.title, subtitle: `${incident.service} · ${incident.severity}` };
}

export function IncidentHeader({ incident, steps, menu }: { incident: IncidentCreated; steps: InvestigationStep[]; menu: MenuItem[] }) {
  const now = useNow(true);
  const { title, subtitle } = headlineOf(incident, steps);
  const open = incident.status === "open";
  return (
    <div className="flex items-start gap-4">
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${open ? "bg-gradient-to-br from-severity to-[#c42b4a] shadow-[0_6px_20px_rgba(255,77,77,0.25)]" : "bg-success/90"}`}>
        {open ? <TriangleAlert className="h-5 w-5 text-white" aria-hidden="true" /> : <Check className="h-5 w-5 text-black" aria-hidden="true" />}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-xl font-semibold tracking-tight text-ink" title={title}>
          {title}
        </h2>
        <p className="mt-0.5 truncate text-sm text-muted" title={subtitle}>
          {subtitle}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <IncidentChip id={incident.id} tone={open ? "severity" : "success"} />
          <span className="font-mono text-muted">{incident.service}</span>
          <span className="font-mono text-muted">{incident.severity}</span>
          {!open && <span className="rounded-full bg-success/10 px-2 py-0.5 font-medium text-success">resolved</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-xs text-muted">{relativeAge(incident.created_at, now)}</span>
        <Menu items={menu} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the three evidence cards

function CardShell({ icon, title, aside, onOpen, children }: { icon: ReactNode; title: string; aside?: ReactNode; onOpen?: () => void; children: ReactNode }) {
  return (
    <section className="panel-inset flex min-h-[244px] flex-col p-4">
      <header className="mb-3.5 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2.5 text-[15px] font-medium text-ink">
          <span className="text-ink/90">{icon}</span>
          {title}
        </h3>
        {onOpen ? (
          <button type="button" onClick={onOpen} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted transition-colors hover:bg-white/[0.05] hover:text-ink">
            {aside}
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : (
          aside && <span className="text-xs text-muted">{aside}</span>
        )}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-3 pt-1">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="h-6 w-6 animate-pulse rounded-full bg-white/[0.06]" />
          <span className="h-3 animate-pulse rounded-full bg-white/[0.06]" style={{ width: `${70 - i * 12}%` }} />
        </div>
      ))}
    </div>
  );
}

interface FixRow {
  action: string;
  incidents: string[];
  outcome: "worked" | "failed";
}

/** Same action in several incidents is one row, counted once per incident. */
function groupFixes(records: FixRecord[], outcome: "worked" | "failed"): FixRow[] {
  const rows: FixRow[] = [];
  for (const r of records) {
    const existing = rows.find((row) => row.action.toLowerCase() === r.action.toLowerCase());
    if (existing) {
      if (!existing.incidents.includes(r.incident_id)) existing.incidents.push(r.incident_id);
    } else {
      rows.push({ action: r.action, incidents: [r.incident_id], outcome });
    }
  }
  return rows.sort((a, b) => b.incidents.length - a.incidents.length);
}

export function TeamMemoryCard({ run, onOpen }: { run: WorkspaceRun; onOpen: () => void }) {
  const d = run.diagnosis;
  const worked = d ? d.worked_fixes : run.fix?.worked ?? [];
  const failed = d ? d.failed_fixes : run.fix?.failed ?? [];
  const rows = [...groupFixes(worked, "worked").slice(0, 2), ...groupFixes(failed, "failed").slice(0, 2)];
  const loose = Boolean(d && d.memory_enabled && !d.strong_match);

  let body: ReactNode;
  if (!run.memory) {
    body = (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Without memory</p>
        <p className="mt-1.5 text-sm text-muted">Memory is off, so nothing from past incidents was recalled. This answer comes from the alert alone.</p>
      </div>
    );
  } else if (run.unavailable) {
    body = <p className="text-sm text-severity">Hindsight is unavailable. Nothing was recalled, so the answer uses the current context only.</p>;
  } else if (!run.fix) {
    body = run.error ? <p className="text-sm text-muted">The investigation stopped before memory was searched.</p> : <Skeleton lines={4} />;
  } else if (rows.length === 0) {
    body = <p className="text-sm text-muted">No similar incidents in memory yet. This one will be the first.</p>;
  } else {
    body = (
      <ul className="space-y-3">
        {rows.map((row, i) => (
          <motion.li
            key={row.outcome + row.action}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2, delay: i * 0.07 }}
            className="flex items-start gap-3"
          >
            <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${row.outcome === "worked" ? "bg-success/20 text-success" : "bg-severity/20 text-severity"}`}>
              {row.outcome === "worked" ? <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" /> : <X className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-1 text-sm text-ink" title={row.action}>
                {row.action}
              </p>
              <p className={`mt-0.5 flex flex-wrap items-center gap-1 text-xs ${row.outcome === "worked" ? "text-muted" : "text-severity"}`}>
                {row.outcome === "worked" ? "Worked" : "Failed"} {row.incidents.length} time{row.incidents.length === 1 ? "" : "s"}
                <span className="ml-1 inline-flex flex-wrap gap-1">
                  {row.incidents.slice(0, 3).map((id) => (
                    <IncidentChip key={id} id={id} tone="muted" />
                  ))}
                </span>
              </p>
            </div>
          </motion.li>
        ))}
        {loose && <li className="text-[11px] text-amber-300">No strong precedent confirmed: shown for context, not used as evidence.</li>}
      </ul>
    );
  }

  const remembers = Boolean(d?.memory_enabled && d.strong_match);
  return (
    <CardShell
      icon={<Database className="h-5 w-5" aria-hidden="true" />}
      title={remembers ? "FRIDAY Remembers" : "Team Memory"}
      aside={run.memory && !run.unavailable && rows.length > 0 ? "View experience" : undefined}
      onOpen={run.memory && has(run, "recall") ? onOpen : undefined}
    >
      {body}
    </CardShell>
  );
}

export function CodeCard({ run, projectName, onConnect }: { run: WorkspaceRun; projectName: string | null; onConnect: (() => void) | null }) {
  const [status, setStatus] = useState<string | null>(null);
  const inspect = stepOf(run, "inspect");
  const finding = run.findings[0] ?? null;
  const noProject = inspect?.detail.startsWith("No project connected") ?? false;

  async function openFile(f: CodeFinding) {
    if (!desktop) return;
    const result = await desktop.openFile(f.abs_path, f.line);
    setStatus(result.ok ? result.message : `${result.message} Path: ${f.abs_path}:${f.line}`);
  }

  let body: ReactNode;
  if (!run.memory || run.unavailable) {
    body = <p className="text-sm text-muted">Code is inspected against what past fixes changed, so it needs memory.</p>;
  } else if (!inspect) {
    body = run.running && has(run, "evidence") ? (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading {projectName ?? "the project"}...
      </p>
    ) : run.error ? (
      <p className="text-sm text-muted">The investigation stopped before the project was read.</p>
    ) : (
      <Skeleton lines={5} />
    );
  } else if (noProject) {
    body = (
      <div className="flex h-full flex-col items-start justify-center gap-3">
        <p className="text-sm text-muted">No project is connected, so FRIDAY cannot point at the line past fixes changed.</p>
        {onConnect ? (
          <button type="button" onClick={onConnect} className="btn btn-secondary btn-sm">
            <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" /> Connect a project
          </button>
        ) : (
          <p className="text-xs text-muted">Connect one from the desktop app.</p>
        )}
      </div>
    );
  } else if (!finding) {
    body = <p className="text-sm text-muted">{inspect.detail}. Nothing in the project matches the settings past fixes changed.</p>;
  } else {
    body = (
      <div className="space-y-2">
        <div className="code-well overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
            <button
              type="button"
              onClick={() => void openFile(finding)}
              disabled={!desktop}
              className="flex min-w-0 items-center gap-2 font-mono text-xs text-ink hover:underline disabled:no-underline"
              title={desktop ? "Open in your editor at this line" : finding.abs_path}
            >
              <Code2 className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
              <span className="truncate">{finding.path}</span>
            </button>
            <span className="shrink-0 font-mono text-[11px] text-muted">Line {finding.line}</span>
          </div>
          <pre className="overflow-x-auto py-1.5 font-mono text-[12px] leading-6">
            {finding.snippet.map((line) => (
              <div key={line.no} className={line.no === finding.line ? "bg-severity/20 text-ink" : "text-ink/80"}>
                <span className="inline-block w-10 select-none pr-3 text-right text-muted/60">{line.no}</span>
                {line.text}
              </div>
            ))}
          </pre>
        </div>
        <p className="line-clamp-2 text-[11px] text-muted">
          <LinkedText text={finding.note} />
        </p>
        {status && <p className="text-[11px] text-muted">{status}</p>}
      </div>
    );
  }

  return (
    <CardShell icon={<Code2 className="h-5 w-5" aria-hidden="true" />} title="Current Project" aside={projectName ?? undefined}>
      {body}
    </CardShell>
  );
}

export function RootCauseCard({ run, onOpen, onRetry }: { run: WorkspaceRun; onOpen: () => void; onRetry: () => void }) {
  const d = run.diagnosis;
  const now = useNow(run.running);
  let body: ReactNode;
  if (run.error) {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-severity">{run.error}</p>
        <button type="button" onClick={onRetry} className="btn btn-secondary btn-sm">
          Try again
        </button>
      </div>
    );
  } else if (!d) {
    body = (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {!run.memory
            ? "Asking the model without memory..."
            : has(run, "inspect")
              ? `Hindsight is reasoning over ${run.matchedCount} matching incidents`
              : "Investigating..."}
          <span className="font-mono text-xs">{duration(now - run.startedAt)}</span>
        </p>
        <Skeleton lines={3} />
      </div>
    );
  } else {
    const top = d.hypotheses[0];
    const headline = d.degraded ? "Plain-text answer" : top ? top.cause : d.strong_match ? "Precedent confirmed" : "No strong precedent in memory";
    body = (
      <div className="space-y-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Likely cause</p>
        <p className="-mt-1.5 text-[15px] font-semibold leading-snug text-ink">{headline}</p>
        <p className="line-clamp-5 text-sm leading-6 text-muted">
          <LinkedText text={d.summary} />
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-muted">
          <span className={`rounded-full px-2 py-0.5 font-mono ${d.memory_enabled ? "bg-white/[0.06] text-ink" : "bg-white/[0.04]"}`}>
            {d.confidence === null ? "confidence n/a" : `${percent(d.confidence)} confident`}
          </span>
          {!d.memory_enabled && <span className="rounded-full bg-white/[0.04] px-2 py-0.5">without memory</span>}
          {d.cited_incidents.slice(0, 4).map((id) => (
            <IncidentChip key={id} id={id} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <CardShell icon={<Lightbulb className="h-5 w-5" aria-hidden="true" />} title="FRIDAY's Answer" aside={d ? "Show why" : undefined} onOpen={d ? onOpen : undefined}>
      {body}
    </CardShell>
  );
}

// ------------------------------------------------------------------ what to do next

function NextStep({ n, state, title, subtitle, onClick, children, last }: {
  n: number;
  state: "done" | "current" | "todo";
  title: ReactNode;
  subtitle?: ReactNode;
  onClick?: () => void;
  children?: ReactNode;
  last?: boolean;
}) {
  const circle =
    state === "done"
      ? "bg-success text-black"
      : state === "current"
        ? "bg-success text-black shadow-[0_0_16px_rgba(53,208,111,0.35)]"
        : "border border-white/[0.14] text-ink";
  const Tag = onClick ? "button" : "div";
  return (
    <li className="flex min-w-0 flex-1 items-center gap-2">
      <Tag
        {...(onClick ? { type: "button" as const, onClick } : {})}
        className={`flex min-w-0 flex-1 items-center gap-3 rounded-xl p-2 text-left ${onClick ? "transition-colors hover:bg-white/[0.04]" : ""}`}
      >
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-mono text-sm font-semibold ${circle}`}>
          {state === "done" ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden="true" /> : n}
        </span>
        <span className="min-w-0">
          <span className="line-clamp-1 text-sm font-medium text-ink">{title}</span>
          {subtitle && <span className="mt-0.5 line-clamp-1 text-xs text-muted">{subtitle}</span>}
          {children}
        </span>
      </Tag>
      {!last && <ChevronRight className="h-4 w-4 shrink-0 text-muted/60" aria-hidden="true" />}
    </li>
  );
}

export function NextStepsCard({ run, incident, recorded, resolved, onOutcome, onResolve, onDetails, onLogAttempt }: {
  run: WorkspaceRun;
  incident: IncidentCreated;
  recorded: Outcome | null;
  resolved: boolean;
  onOutcome: (action: string, outcome: Outcome) => void;
  onResolve: () => void;
  onDetails: () => void;
  onLogAttempt: () => void;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const d = run.diagnosis;
  if (!d) {
    return (
      <section className="panel px-6 py-5">
        <h3 className="flex items-center gap-2.5 text-[15px] font-medium text-ink">
          <ListOrdered className="h-5 w-5" aria-hidden="true" /> What to do next
        </h3>
        <p className="mt-3 text-sm text-muted">{run.error ? "No recommendation: the investigation did not finish." : "The steps appear once every citation has been verified."}</p>
      </section>
    );
  }

  const finding = d.findings[0] ?? null;
  const fix = d.try_first;
  const open = incident.status === "open";

  async function openFinding(f: CodeFinding) {
    if (desktop) {
      const result = await desktop.openFile(f.abs_path, f.line);
      setOpened(result.ok ? result.message : `${result.message} Path: ${f.abs_path}:${f.line}`);
    } else {
      try {
        await navigator.clipboard.writeText(`${f.abs_path}:${f.line}`);
        setOpened(`Path copied: ${f.abs_path}:${f.line}`);
      } catch {
        setOpened(`Open ${f.abs_path} at line ${f.line}`);
      }
    }
  }

  const s1Done = opened !== null;
  const s3Done = recorded !== null;
  const current = !s1Done && finding ? 1 : !s3Done && open ? (fix ? 2 : 3) : resolved ? 5 : 4;
  const stateOf = (n: number, done: boolean): "done" | "current" | "todo" => (done ? "done" : n === current ? "current" : "todo");

  return (
    <section className="panel px-6 py-5">
      <h3 className="flex items-center gap-2.5 text-[15px] font-medium text-ink">
        <ListOrdered className="h-5 w-5" aria-hidden="true" /> What to do next
      </h3>
      <ol className="mt-4 flex flex-col gap-2 lg:flex-row lg:items-center">
        {finding ? (
          <NextStep
            n={1}
            state={stateOf(1, s1Done)}
            title={<>Open <span className="font-mono text-[13px]">{finding.path.split("/").slice(-2).join("/")}</span></>}
            subtitle={`Go to line ${finding.line}${finding.current_value !== null ? ` · ${finding.identifier} = ${finding.current_value}` : ""}`}
            onClick={() => void openFinding(finding)}
          />
        ) : (
          <NextStep n={1} state={stateOf(1, true)} title="Read the evidence" subtitle="Why FRIDAY thinks this" onClick={onDetails} />
        )}
        {fix ? (
          <NextStep
            n={2}
            state={stateOf(2, s3Done)}
            title={<span title={fix.action}>{fix.action}</span>}
            subtitle={fix.evidence.length > 0 ? `Worked in ${fix.evidence.join(", ")}` : "Suggested first"}
            onClick={onDetails}
          />
        ) : (
          <NextStep n={2} state={stateOf(2, s3Done)} title="No verified fix yet" subtitle={d.memory_enabled ? "Nothing in memory is a strong match" : "Memory is off"} onClick={onDetails} />
        )}
        <NextStep
          n={3}
          state={stateOf(3, s3Done)}
          title={fix ? "Verify the fix" : "Log what you tried"}
          subtitle={
            recorded
              ? `Recorded: ${recorded === "worked" ? "worked" : recorded === "partial" ? "partly worked" : "did not work"}`
              : fix
                ? "Did it stop the error?"
                : "Failures teach memory too"
          }
          onClick={fix && open && !recorded ? undefined : onLogAttempt}
        >
          {fix && open && !recorded && d.memory_enabled && (
            <span className="mt-1.5 flex gap-1.5">
              <button type="button" onClick={() => onOutcome(fix.action, "worked")} className="btn btn-success !px-2 !py-0.5 text-[11px]">
                Worked
              </button>
              <button type="button" onClick={() => onOutcome(fix.action, "partial")} className="btn btn-amber !px-2 !py-0.5 text-[11px]">
                Partly
              </button>
              <button type="button" onClick={() => onOutcome(fix.action, "failed")} className="btn btn-danger !px-2 !py-0.5 text-[11px]">
                Didn't work
              </button>
            </span>
          )}
        </NextStep>
        <NextStep
          n={4}
          state={stateOf(4, resolved)}
          title={resolved ? "Learned" : "Resolve & learn"}
          subtitle={resolved ? "Saved to memory" : "Save this experience"}
          onClick={open ? onResolve : undefined}
          last
        />
      </ol>
      {opened && <p className="mt-2 pl-2 text-[11px] text-muted">{opened}</p>}
    </section>
  );
}
