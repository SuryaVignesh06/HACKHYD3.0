// Diagnosis sections shared by the console and the desktop overlay. Everything shown is derived from the
// streamed steps and the verified Diagnosis; nothing here invents a number, a file or a past outcome.
import { useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import {
  Brain,
  Check,
  ClipboardCopy,
  ExternalLink,
  FileCode2,
  FolderSearch,
  History,
  Lightbulb,
  ListChecks,
  ScanText,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { desktop } from "../lib/desktop";
import { dateWithAge, percent } from "../lib/format";
import type { CodeFinding, Diagnosis, FixRecord, InvestigationStep, MatchedIncident } from "../lib/types";
import { IncidentChip, LinkedText } from "./IncidentPeek";

// ------------------------------------------------------------------ helpers

interface GroupedFix {
  action: string;
  incidents: string[];
}

/** Same action in several incidents is one row with several citations. */
function group(records: FixRecord[]): GroupedFix[] {
  const rows: GroupedFix[] = [];
  for (const r of records) {
    const existing = rows.find((row) => row.action.toLowerCase() === r.action.toLowerCase());
    if (existing) {
      if (!existing.incidents.includes(r.incident_id)) existing.incidents.push(r.incident_id);
    } else {
      rows.push({ action: r.action, incidents: [r.incident_id] });
    }
  }
  return rows.sort((a, b) => b.incidents.length - a.incidents.length);
}

export function signatureOf(steps: InvestigationStep[]): string | null {
  const parse = steps.find((s) => s.name === "parse");
  const marker = parse?.detail.indexOf("signature: ") ?? -1;
  return parse && marker >= 0 ? parse.detail.slice(marker + "signature: ".length) || null : null;
}

export interface HistoricalChange {
  incident: string;
  from: string;
  to: string;
  worked: boolean;
}

/** Parses the finder's "INC-037: REDIS_MAX_POOL from 20 to 50" entries; "worked" only if that incident's fix log says so. */
export function changesOf(finding: CodeFinding, worked: FixRecord[]): HistoricalChange[] {
  const changes: HistoricalChange[] = [];
  for (const entry of finding.history) {
    const match = /^(INC-\d{3,}):\s+\S+\s+from\s+(\S+)\s+to\s+(\S+)$/.exec(entry);
    if (!match) continue;
    const [, incident, from, to] = match as unknown as [string, string, string, string];
    const didWork = worked.some((w) => w.incident_id === incident && w.action.includes(finding.identifier) && w.action.includes(to));
    changes.push({ incident, from, to, worked: didWork });
  }
  return changes;
}

function Section({ title, icon, tone = "text-muted", aside, children }: {
  title: string;
  icon: ReactNode;
  tone?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className={`eyebrow flex items-center gap-1.5 ${tone}`}>
          {icon}
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ lifecycle rail

type StageState = "pending" | "active" | "done" | "skipped" | "failed";

export function Lifecycle({ memoryOn, steps, running, diagnosis, retained, matchedCount }: {
  memoryOn: boolean;
  steps: InvestigationStep[];
  running: boolean;
  diagnosis: Diagnosis | null;
  retained: boolean | null; // null: not resolved yet
  matchedCount: number;
}) {
  const has = (name: string) => steps.some((s) => s.name === name);
  const unavailable = diagnosis?.memory_unavailable || steps.some((s) => s.name === "recall" && s.detail.startsWith("Hindsight unavailable"));
  const stage = (done: boolean, started: boolean): StageState => (done ? "done" : running && started ? "active" : "pending");

  const stages: { key: string; label: string; state: StageState; detail: string }[] = [
    {
      key: "context",
      label: "Context",
      state: stage(has("parse"), true),
      detail: has("parse") ? "Alert read" : "Reading current context",
    },
    {
      key: "recall",
      label: "Recall",
      state: !memoryOn ? "skipped" : unavailable ? "failed" : stage(has("recall"), has("parse")),
      detail: !memoryOn
        ? "Memory off"
        : unavailable
          ? "Hindsight unavailable"
          : has("recall")
            ? `${matchedCount} incidents retrieved`
            : "Recalling memory",
    },
    {
      key: "reflect",
      label: "Reflect",
      state: !memoryOn || unavailable ? "skipped" : stage(has("reflect"), has("recall")),
      detail: !memoryOn || unavailable
        ? "Not used"
        : diagnosis
          ? diagnosis.strong_match
            ? "Precedent confirmed"
            : "No strong precedent"
          : has("reflect")
            ? "Verifying citations"
            : "Reflecting",
    },
    {
      key: "retain",
      label: "Retain",
      state: retained === null ? "pending" : retained ? "done" : "failed",
      detail: retained === null ? "After you resolve" : retained ? "Experience captured" : "Not saved",
    },
  ];

  return (
    <ol className="grid grid-cols-4 gap-1.5" aria-label="Memory lifecycle">
      {stages.map((s, i) => {
        const color =
          s.state === "done"
            ? "border-memory/35 bg-memory/[0.08]"
            : s.state === "active"
              ? "border-memory/50 bg-memory/[0.12]"
              : s.state === "failed"
                ? "border-amber-400/35 bg-amber-400/[0.07]"
                : "border-white/[0.06] bg-white/[0.02]";
        const dot =
          s.state === "done" ? "bg-memory" : s.state === "active" ? "bg-memory animate-pulse" : s.state === "failed" ? "bg-amber-400" : "bg-white/20";
        return (
          <motion.li
            key={s.key}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, delay: i * 0.05 }}
            className={`min-w-0 rounded-xl border px-2.5 py-2 transition-colors duration-300 ${color}`}
          >
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink/90">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
              {s.label}
            </p>
            <p className={`mt-0.5 truncate text-[11px] ${s.state === "active" ? "text-memory" : s.state === "failed" ? "text-amber-300" : "text-muted"}`}>
              {s.detail}
            </p>
          </motion.li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------------ I remember this

/** Shown only when a cited precedent was resolved in this app, i.e. the agent learned it itself. */
export function Remembered({ diagnosis }: { diagnosis: Diagnosis }) {
  const learned = diagnosis.matched.find((m) => m.learned_live && diagnosis.cited_incidents.includes(m.id));
  if (!learned) return null;
  const record = diagnosis.worked_fixes.find((w) => w.incident_id === learned.id);
  const action = record?.action ?? (diagnosis.try_first?.source === learned.id ? diagnosis.try_first.action : null);
  if (!action) return null;
  const file = diagnosis.findings.find((f) => f.related_incidents.includes(learned.id));
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 26 }}
      className="relative overflow-hidden rounded-2xl border border-memory/40 bg-gradient-to-br from-memory/[0.16] via-memory/[0.06] to-transparent p-4"
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-memory">
        <Brain className="h-4 w-4" aria-hidden="true" /> I remember this resolution.
      </p>
      <p className="mt-0.5 text-xs text-muted">Learned here ({dateWithAge(learned.occurred_at)}), not from seeded history.</p>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-muted">Previous incident</dt>
        <dd className="flex min-w-0 items-center gap-2">
          <IncidentChip id={learned.id} />
          <span className="truncate text-ink">{learned.title}</span>
        </dd>
        <dt className="text-muted">Previous action</dt>
        <dd className="text-ink">{action}</dd>
        <dt className="text-muted">Outcome</dt>
        <dd className="flex items-center gap-1 text-success">
          <Check className="h-3.5 w-3.5" aria-hidden="true" /> {record ? "Worked" : "Recommended from that incident's fix log"}
        </dd>
        {file && (
          <>
            <dt className="text-muted">Related file</dt>
            <dd className="font-mono text-ink">
              {file.path}
              <span className="text-amber-300">:{file.line}</span>
            </dd>
          </>
        )}
      </dl>
    </motion.div>
  );
}

// ------------------------------------------------------------------ Hindsight memory: worked vs failed

export function FixHistory({ matched, worked, failed, final, strong }: {
  matched: MatchedIncident[];
  worked: FixRecord[];
  failed: FixRecord[];
  final: boolean; // true once the diagnosis is verified; before that the lists are candidates from the fix log
  strong: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const good = group(worked);
  const bad = group(failed);
  const limit = expanded ? 99 : 3;
  const best = matched[0];

  return (
    <div className="tile-memory space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow flex items-center gap-1.5 !text-memory">
            <Brain className="h-3.5 w-3.5" aria-hidden="true" /> Hindsight memory
          </p>
          <p className="mt-1 text-sm text-ink">
            {matched.length === 0 ? (
              "No related incidents in memory yet. This one will be the first."
            ) : (
              <>
                <span className="font-mono">{matched.length}</span> related incident{matched.length === 1 ? "" : "s"} recalled
                {best && (
                  <span className="text-muted">
                    {" "}
                    · best {best.id} at {percent(best.relevance)}
                  </span>
                )}
              </>
            )}
          </p>
        </div>
        {matched.length > 0 && (
          <div className="flex gap-5">
            <div className="text-right">
              <p className="font-mono text-xl text-success">{worked.length}</p>
              <p className="text-[11px] text-muted">successful fixes</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-xl text-severity">{failed.length}</p>
              <p className="text-[11px] text-muted">failed approaches</p>
            </div>
          </div>
        )}
      </div>

      {final && !strong && matched.length > 0 && (
        <p className="text-xs text-amber-300">No strong precedent was confirmed, so no past fix is presented as applying here.</p>
      )}

      {(good.length > 0 || bad.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-[11px] font-medium text-success">Worked before</p>
            {good.length === 0 && <p className="text-xs text-muted">None recorded.</p>}
            <ul className="space-y-2">
              {good.slice(0, limit).map((row, i) => (
                <motion.li
                  key={row.action}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.18, delay: i * 0.07 }}
                  className="flex items-start gap-2 text-xs"
                >
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success/15">
                    <Check className="h-3 w-3 text-success" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="block leading-5 text-ink">{row.action}</span>
                    <span className="flex flex-wrap gap-1">
                      {row.incidents.map((id) => (
                        <IncidentChip key={id} id={id} tone="success" />
                      ))}
                    </span>
                  </span>
                </motion.li>
              ))}
            </ul>
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-medium text-severity">Failed before</p>
            {bad.length === 0 && <p className="text-xs text-muted">None recorded.</p>}
            <ul className="space-y-2">
              {bad.slice(0, limit).map((row, i) => (
                <motion.li
                  key={row.action}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.18, delay: i * 0.07 }}
                  className="flex items-start gap-2 text-xs"
                >
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-severity/15">
                    <X className="h-3 w-3 text-severity" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="block leading-5 text-ink">{row.action}</span>
                    <span className="flex flex-wrap gap-1">
                      {row.incidents.map((id) => (
                        <IncidentChip key={id} id={id} tone="severity" />
                      ))}
                    </span>
                  </span>
                </motion.li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {(good.length > 3 || bad.length > 3) && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="btn btn-ghost btn-sm -ml-2">
          {expanded ? "Show fewer" : `Show all ${good.length + bad.length} approaches`}
        </button>
      )}
      {!final && (worked.length > 0 || failed.length > 0) && (
        <p className="text-[11px] text-muted">From the fix logs of recalled incidents. Hindsight is still reasoning about whether they apply.</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ evidence with sources

type Source = "Current alert" | "Hindsight recall" | "Hindsight reflect" | "Fix log" | "Project file";

const SOURCE_TONE: Record<Source, string> = {
  "Current alert": "bg-severity/10 text-severity",
  "Hindsight recall": "bg-memory/10 text-memory",
  "Hindsight reflect": "bg-memory/10 text-memory",
  "Fix log": "bg-success/10 text-success",
  "Project file": "bg-amber-400/10 text-amber-300",
};

export function Evidence({ diagnosis }: { diagnosis: Diagnosis }) {
  const items: { source: Source; body: ReactNode }[] = [];
  const signature = signatureOf(diagnosis.steps);
  if (signature) items.push({ source: "Current alert", body: <span className="font-mono text-[11px]">{signature}</span> });
  const cited = diagnosis.matched.filter((m) => diagnosis.cited_incidents.includes(m.id));
  if (cited.length > 0) {
    items.push({
      source: "Hindsight recall",
      body: (
        <span className="inline-flex flex-wrap items-center gap-1">
          Matches {cited.length} past incident{cited.length === 1 ? "" : "s"} with the same failure mechanism:
          {cited.map((m) => (
            <IncidentChip key={m.id} id={m.id} />
          ))}
        </span>
      ),
    });
  }
  const reflect = diagnosis.steps.find((s) => s.name === "reflect");
  if (reflect && diagnosis.strong_match) items.push({ source: "Hindsight reflect", body: <LinkedText text={reflect.detail} /> });
  if (diagnosis.try_first && diagnosis.try_first.evidence.length > 0) {
    items.push({
      source: "Fix log",
      body: (
        <span className="inline-flex flex-wrap items-center gap-1">
          The recommended fix worked in {diagnosis.try_first.evidence.length} incident{diagnosis.try_first.evidence.length === 1 ? "" : "s"}:
          {diagnosis.try_first.evidence.map((id) => (
            <IncidentChip key={id} id={id} tone="success" />
          ))}
        </span>
      ),
    });
  }
  for (const a of diagnosis.avoid) {
    items.push({
      source: "Fix log",
      body: (
        <span className="inline-flex flex-wrap items-center gap-1">
          "{a.action}" failed in
          {a.evidence.map((id) => (
            <IncidentChip key={id} id={id} tone="severity" />
          ))}
        </span>
      ),
    });
  }
  for (const f of diagnosis.findings) {
    items.push({
      source: "Project file",
      body: (
        <span>
          <span className="font-mono text-[11px]">
            {f.identifier}
            {f.current_value !== null ? ` = ${f.current_value}` : ""}
          </span>{" "}
          at{" "}
          <span className="font-mono text-[11px]">
            {f.path}:{f.line}
          </span>
        </span>
      ),
    });
  }
  if (items.length === 0) return null;
  return (
    <Section title="Evidence" icon={<ListChecks className="h-3.5 w-3.5" aria-hidden="true" />}>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2.5 text-xs leading-5 text-ink">
            <span className={`mt-[1px] w-[108px] shrink-0 rounded-full px-2 py-[1px] text-center text-[10px] font-medium ${SOURCE_TONE[item.source]}`}>
              {item.source}
            </span>
            <span className="min-w-0 flex-1">{item.body}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ------------------------------------------------------------------ what to do next

export function Snippet({ finding }: { finding: CodeFinding }) {
  return (
    <pre className="glass-well overflow-x-auto rounded-xl py-1.5 font-mono text-[11px] leading-5">
      {finding.snippet.map((line) => (
        <div
          key={line.no}
          className={line.no === finding.line ? "border-l-2 border-amber-400 bg-amber-400/10 pr-3 text-ink" : "border-l-2 border-transparent pr-3 text-muted"}
        >
          <span className="inline-block w-9 select-none pr-2 text-right text-muted/60">{line.no}</span>
          {line.text}
        </div>
      ))}
    </pre>
  );
}

export function FileActions({ finding }: { finding: CodeFinding }) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const location = `${finding.abs_path}:${finding.line}`;

  async function open() {
    if (!desktop) return;
    setBusy(true);
    const result = await desktop.openFile(finding.abs_path, finding.line);
    setBusy(false);
    // Report exactly what happened; a failed launch never reads as success.
    setStatus(result.ok ? result.message : `${result.message} Open it manually: ${location}`);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(location);
      setStatus("Path copied.");
    } catch {
      setStatus(`Copy failed. The path is ${location}`);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        {desktop && (
          <button type="button" disabled={busy} onClick={() => void open()} className="btn btn-secondary btn-sm">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> Open file
          </button>
        )}
        <button type="button" onClick={() => void copy()} className="btn btn-secondary btn-sm">
          <ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" /> Copy path
        </button>
      </div>
      {!desktop && <p className="text-[11px] text-muted">Open this file manually: <span className="font-mono text-ink">{location}</span></p>}
      {status && <p className="text-[11px] text-muted">{status}</p>}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: ReactNode; children?: ReactNode }) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <span className="step-line absolute left-[11px] top-7 h-[calc(100%-1.75rem)] w-px bg-white/[0.08]" aria-hidden="true" />
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] font-mono text-[11px] text-ink">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <div className="text-sm text-ink">{title}</div>
        {children}
      </div>
    </li>
  );
}

export function NextSteps({ diagnosis, resolveHint = true }: { diagnosis: Diagnosis; resolveHint?: boolean }) {
  const [showSnippet, setShowSnippet] = useState(true);
  const primary = diagnosis.findings[0];
  const others = diagnosis.findings.slice(1);
  const fix = diagnosis.try_first;
  if (!diagnosis.memory_enabled || (!primary && !fix)) return null;

  const changes = primary ? changesOf(primary, diagnosis.worked_fixes) : [];
  const successful = changes.filter((c) => c.worked);
  const target = successful[successful.length - 1] ?? null;
  let n = 0;

  return (
    <Section
      title="What to do next"
      icon={<Lightbulb className="h-3.5 w-3.5" aria-hidden="true" />}
      tone="text-amber-300"
      aside={primary && (
        <button type="button" onClick={() => setShowSnippet((v) => !v)} className="btn btn-ghost btn-sm">
          {showSnippet ? "Hide code" : "Show code"}
        </button>
      )}
    >
      <ol className="tile">
        {primary && (
          <>
            <Step
              n={++n}
              title={
                <span className="flex flex-wrap items-center gap-1.5">
                  Open <span className="font-mono text-[13px]">{diagnosis.project ? `${diagnosis.project}/` : ""}{primary.path}</span>
                </span>
              }
            >
              <FileActions finding={primary} />
            </Step>
            <Step n={++n} title={<>Go to line <span className="font-mono text-amber-300">{primary.line}</span></>}>
              {showSnippet && <Snippet finding={primary} />}
            </Step>
            <Step n={++n} title={<>Check <span className="font-mono text-[13px]">{primary.identifier}</span></>}>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="glass-well rounded-xl px-3 py-2">
                  <p className="text-[11px] text-muted">Current (read from disk)</p>
                  <p className="font-mono text-base text-ink">{primary.current_value ?? "not assigned here"}</p>
                </div>
                <div className="glass-well rounded-xl px-3 py-2">
                  <p className="text-[11px] text-muted">{target ? "Historical successful value" : "Changed in past fixes"}</p>
                  {target ? (
                    <p className="flex items-center gap-2 font-mono text-base text-success">
                      {target.to} <IncidentChip id={target.incident} tone="success" />
                    </p>
                  ) : changes.length > 0 ? (
                    <p className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-ink">
                      {changes.map((c) => (
                        <span key={c.incident + c.to} className="inline-flex items-center gap-1">
                          {c.from} to {c.to} <IncidentChip id={c.incident} tone="muted" />
                        </span>
                      ))}
                    </p>
                  ) : (
                    <p className="flex flex-wrap items-center gap-1 text-xs text-muted">
                      Part of the fix in
                      {primary.related_incidents.map((id) => (
                        <IncidentChip key={id} id={id} tone="muted" />
                      ))}
                    </p>
                  )}
                </div>
              </div>
              {target && primary.current_value === target.from && (
                <p className="text-xs text-amber-300">This configuration matches the state before the fix in {target.incident}.</p>
              )}
              {others.length > 0 && (
                <ul className="space-y-1 text-[11px] text-muted">
                  {others.map((f) => (
                    <li key={f.path + f.line} className="flex items-center gap-1.5">
                      <FileCode2 className="h-3 w-3" aria-hidden="true" /> Also check{" "}
                      <span className="font-mono text-ink">
                        {f.identifier}
                        {f.current_value !== null ? ` = ${f.current_value}` : ""}
                      </span>{" "}
                      at <span className="font-mono">{f.path}:{f.line}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Step>
          </>
        )}
        {fix && (
          <Step n={++n} title="Apply the change">
            <p className="text-xs leading-5 text-muted">{fix.action}</p>
          </Step>
        )}
        <Step n={++n} title="Verify">
          <p className="text-xs leading-5 text-muted">
            Confirm the error stops in the service logs or dashboard. You make the change; the agent never runs it for you.
          </p>
        </Step>
        {resolveHint && (
          <Step n={++n} title="Resolve and learn">
            <p className="text-xs leading-5 text-muted">Record what happened so the next incident starts from your result.</p>
          </Step>
        )}
      </ol>
    </Section>
  );
}

// ------------------------------------------------------------------ likely root cause

export function RootCause({ diagnosis }: { diagnosis: Diagnosis }) {
  const top = diagnosis.hypotheses[0];
  if (!top) return null;
  return (
    <Section title="Likely root cause" icon={<Search className="h-3.5 w-3.5" aria-hidden="true" />}>
      <div className="flex items-start justify-between gap-4">
        <p className="text-[15px] font-medium leading-6 text-ink">{top.cause}</p>
        <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-xs text-ink">{percent(top.confidence)}</span>
      </div>
      {diagnosis.hypotheses.length > 1 && (
        <ul className="space-y-1">
          {diagnosis.hypotheses.slice(1).map((h) => (
            <li key={h.cause} className="flex items-start justify-between gap-3 text-xs text-muted">
              <span>{h.cause}</span>
              <span className="font-mono">{percent(h.confidence)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export const STEP_ICON: Record<string, ReactNode> = {
  parse: <ScanText className="h-3.5 w-3.5" aria-hidden="true" />,
  recall: <History className="h-3.5 w-3.5" aria-hidden="true" />,
  evidence: <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />,
  inspect: <FolderSearch className="h-3.5 w-3.5" aria-hidden="true" />,
  reflect: <Brain className="h-3.5 w-3.5" aria-hidden="true" />,
  diagnosis: <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />,
};
