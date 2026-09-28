import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AppWindow,
  Ban,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  ClipboardPaste,
  FolderOpen,
  FolderPlus,
  Loader2,
  MonitorUp,
  NotebookPen,
  Save,
  ScrollText,
  Search,
  ShieldCheck,
  ShieldQuestion,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import CheckHere from "../components/CheckHere";
import { IncidentChip, LinkedText } from "../components/IncidentPeek";
import MarkdownLite from "../components/MarkdownLite";
import { api, streamDiagnosis } from "../lib/api";
import { desktop, looksLikeError, shortcutLabel, type Activation } from "../lib/desktop";
import { dateWithAge, duration, percent } from "../lib/format";
import type {
  AttemptLogged,
  CodeFinding,
  Diagnosis,
  ExperienceCaptured,
  IncidentCreated,
  InvestigationStep,
  MatchedIncident,
  Outcome,
  PostmortemDraft,
  ProjectContext,
  ProjectOut,
  StreamEvent,
} from "../lib/types";

type Phase = "idle" | "context" | "investigating" | "diagnosis" | "resolve" | "learned";
type ContextSource = { kind: "clipboard" | "logs" | "screen" | "manual"; label: string; text: string };

const PROJECT_KEY = "oncall.overlay.project";

function readStoredProject(): number | null {
  try {
    const value = window.localStorage.getItem(PROJECT_KEY);
    return value ? Number(value) : null;
  } catch {
    return null;
  }
}

function storeProject(id: number): void {
  try {
    window.localStorage.setItem(PROJECT_KEY, String(id));
  } catch {
    // Remembering the last project is a convenience; without storage the engineer just picks it again.
  }
}

function Check({ state, children }: { state: "ok" | "missing" | "running"; children: React.ReactNode }) {
  const icon =
    state === "ok" ? (
      <CircleCheck className="h-4 w-4 text-success" aria-hidden="true" />
    ) : state === "running" ? (
      <Loader2 className="h-4 w-4 animate-spin text-memory" aria-hidden="true" />
    ) : (
      <CircleDashed className="h-4 w-4 text-muted" aria-hidden="true" />
    );
  return (
    <motion.li initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.15 }} className="flex items-start gap-2 text-xs">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </motion.li>
  );
}

function HindsightStrip({ matched, steps, diagnosis, retained }: {
  matched: MatchedIncident[];
  steps: InvestigationStep[];
  diagnosis: Diagnosis | null;
  retained: boolean | null;
}) {
  const recall = steps.find((s) => s.name === "recall");
  const reflect = steps.find((s) => s.name === "reflect");
  const cells: { label: string; value: string; tone: string }[] = [
    { label: "Recall", value: recall ? `${matched.length} related incidents` : "searching...", tone: recall ? "text-ink" : "text-memory" },
    {
      label: "Reflect",
      value: !reflect ? "reasoning..." : diagnosis ? (diagnosis.strong_match ? "precedent confirmed" : "no strong precedent") : "done",
      tone: reflect ? "text-ink" : "text-memory",
    },
    {
      label: "Retain",
      value: retained === null ? "after you resolve" : retained ? "experience saved" : "not saved",
      tone: retained ? "text-success" : "text-muted",
    },
  ];
  return (
    <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-memory/30 bg-memory/20">
      {cells.map((cell) => (
        <div key={cell.label} className="bg-black/40 px-2.5 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-memory">{cell.label}</p>
          <p className={`text-[11px] ${cell.tone}`}>{cell.value}</p>
        </div>
      ))}
    </div>
  );
}

const STEP_LABEL: Record<string, string> = {
  parse: "Alert parsed",
  recall: "Hindsight recall",
  evidence: "Past outcomes compared",
  inspect: "Project inspected",
  reflect: "Hindsight reflect",
  diagnosis: "Diagnosis verified",
};

export default function Overlay() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [activation, setActivation] = useState<Activation | null>(null);
  const [projects, setProjects] = useState<ProjectOut[] | null>(null);
  const [projectId, setProjectId] = useState<number | null>(readStoredProject());
  const [context, setContext] = useState<ProjectContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [source, setSource] = useState<ContextSource | null>(null);
  const [manual, setManual] = useState("");
  const [memoryOn, setMemoryOn] = useState(true);
  const [incident, setIncident] = useState<IncidentCreated | null>(null);
  const [steps, setSteps] = useState<InvestigationStep[]>([]);
  const [matched, setMatched] = useState<MatchedIncident[]>([]);
  const [liveFindings, setLiveFindings] = useState<CodeFinding[]>([]);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [attempts, setAttempts] = useState<AttemptLogged[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteOutcome, setNoteOutcome] = useState<Outcome>("failed");
  const [whyOpen, setWhyOpen] = useState(false);
  const [draft, setDraft] = useState<PostmortemDraft | null>(null);
  const [resolveOutcome, setResolveOutcome] = useState<Outcome>("worked");
  const [saveExperience, setSaveExperience] = useState(true);
  const [saving, setSaving] = useState(false);
  const [experience, setExperience] = useState<ExperienceCaptured | null>(null);
  const [screenStatus, setScreenStatus] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const project = projects?.find((p) => p.id === projectId) ?? null;
  const shortcut = shortcutLabel(desktop?.shortcut ?? "Control+Space");

  // Transparent page so only the rounded panel shows in the frameless desktop window.
  useEffect(() => {
    if (!desktop) return;
    const previous = document.body.style.background;
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
    return () => {
      document.body.style.background = previous;
    };
  }, []);

  useEffect(() => {
    desktop?.setExpanded(phase !== "idle" && phase !== "context");
  }, [phase]);

  const loadProjects = useCallback(async () => {
    const result = await api.projects();
    if (!result.ok) {
      setContextError(result.error.message);
      setProjects([]);
      return;
    }
    setProjects(result.data);
    setProjectId((current) => {
      if (current && result.data.some((p) => p.id === current)) return current;
      return result.data.length ? result.data[result.data.length - 1]!.id : null;
    });
  }, []);

  const loadContext = useCallback(async (id: number | null, clipboard: string) => {
    setContext(null);
    setContextError(null);
    if (looksLikeError(clipboard)) {
      setSource({ kind: "clipboard", label: `Clipboard: ${clipboard.trim().split("\n").length} lines that look like an error`, text: clipboard.trim() });
    } else {
      setSource(null);
    }
    if (id === null) return;
    const result = await api.projectContext(id);
    if (!result.ok) {
      setContextError(result.error.message);
      return;
    }
    setContext(result.data);
    const logs = result.data.log_errors;
    if (logs && !looksLikeError(clipboard)) {
      setSource({
        kind: "logs",
        label: `${logs.path}: ${logs.error_count} error${logs.error_count === 1 ? "" : "s"}${logs.latest ? `, latest ${new Date(logs.latest).toLocaleTimeString()}` : ""}`,
        text: `[LOG] recent errors in ${result.data.project.name}/${logs.path}\n${logs.lines.join("\n")}`,
      });
    }
  }, []);

  const begin = useCallback(
    (payload: Activation) => {
      abort.current?.abort();
      setActivation(payload);
      setPhase("context");
      setIncident(null);
      setSteps([]);
      setMatched([]);
      setLiveFindings([]);
      setDiagnosis(null);
      setError(null);
      setAttempts([]);
      setDraft(null);
      setExperience(null);
      setWhyOpen(false);
      setScreenStatus(null);
      setManual("");
      void loadProjects();
    },
    [loadProjects],
  );

  // Desktop: every shortcut press starts a fresh context read. Browser: start immediately.
  useEffect(() => {
    if (desktop) return desktop.onActivated(begin);
    begin({ window: null, clipboard: "", at: new Date().toISOString(), openedInMs: 0 });
    return undefined;
  }, [begin]);

  useEffect(() => {
    if (phase === "context") void loadContext(projectId, activation?.clipboard ?? "");
  }, [phase, projectId, activation, loadContext]);

  useEffect(() => {
    if (phase !== "investigating") return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"]')) desktop?.hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function connectProject() {
    if (!desktop) return;
    const result = await desktop.chooseProject();
    if ("project" in result) {
      storeProject(result.project.id);
      setProjectId(result.project.id);
      await loadProjects();
    } else if ("error" in result) {
      setContextError(result.error);
    }
  }

  async function readScreen() {
    if (!desktop) return;
    setScreenStatus("Capturing the screen...");
    const shot = await desktop.captureScreen();
    if (!shot.ok || !shot.dataUrl) {
      setScreenStatus(shot.message ?? "Screen capture failed.");
      return;
    }
    setScreenStatus("Reading the screen with the vision model...");
    const result = await api.readScreen(shot.dataUrl);
    if (!result.ok) {
      setScreenStatus(result.error.message);
      return;
    }
    if (!result.data.found) {
      setScreenStatus("No error or stack trace was visible on screen.");
      return;
    }
    setSource({ kind: "screen", label: `Screen: ${result.data.summary}`, text: result.data.text });
    setScreenStatus(null);
  }

  const alertText = source?.text ?? manual.trim();

  async function investigate() {
    if (alertText.length < 10) return;
    setError(null);
    const created = await api.createIncident({
      alert_text: alertText,
      ...(project ? { project_id: project.id } : {}),
      origin: source?.kind ?? "manual",
    });
    if (!created.ok) {
      setError(created.error.message);
      return;
    }
    setIncident(created.data);
    setPhase("investigating");
    setStartedAt(Date.now());
    const controller = new AbortController();
    abort.current = controller;
    await streamDiagnosis(
      created.data.id,
      memoryOn,
      (event: StreamEvent) => {
        if (event.type === "step") {
          setSteps((s) => [...s, event.step]);
          const data = event.data;
          if (event.step.name === "recall" && Array.isArray(data.matched)) setMatched(data.matched as MatchedIncident[]);
          if (event.step.name === "inspect" && Array.isArray(data.findings)) setLiveFindings(data.findings as CodeFinding[]);
        } else if (event.type === "diagnosis") {
          setDiagnosis(event.diagnosis);
          setPhase("diagnosis");
        } else {
          setError(event.message);
          setPhase("diagnosis");
        }
      },
      controller.signal,
    );
  }

  async function record(action: string, outcome: Outcome, notes = "") {
    if (!incident) return;
    const result = await api.logAttempt(incident.id, { action, outcome, ...(notes ? { notes } : {}) });
    if (result.ok) setAttempts((a) => [...a, result.data]);
    else setError(result.error.message);
  }

  async function openResolve() {
    if (!incident) return;
    setPhase("resolve");
    const worked = attempts.find((a) => a.outcome === "worked");
    setResolveOutcome(worked || !attempts.length ? "worked" : "failed");
    const result = await api.postmortemDraft(incident.id);
    if (result.ok) {
      setDraft({ ...result.data, fix: worked?.action ?? (result.data.fix || diagnosis?.try_first?.action || "") });
    } else {
      setError(result.error.message);
    }
  }

  async function resolveAndLearn() {
    if (!incident || !draft || saving) return;
    setSaving(true);
    if (!attempts.some((a) => a.action === draft.fix)) {
      await record(draft.fix, resolveOutcome, "recorded when resolving");
    }
    const result = await api.resolve(incident.id, {
      summary: draft.summary,
      root_cause: draft.root_cause,
      fix: draft.fix,
      follow_ups: draft.follow_ups,
      ttr_minutes: draft.ttr_minutes,
      retain: saveExperience,
    });
    setSaving(false);
    if (result.ok) {
      setExperience(result.data);
      setPhase("learned");
    } else {
      setError(result.error.message);
    }
  }

  const findings = diagnosis?.findings ?? liveFindings;
  const tried = diagnosis?.try_first ? attempts.find((a) => a.action === diagnosis.try_first?.action) : undefined;
  const windowLabel = activation?.window ? activation.window.app || activation.window.process : null;

  return (
    <div className={desktop ? "h-screen p-2" : "flex min-h-screen justify-center bg-bg p-6"}>
      <motion.div
        initial={{ opacity: 0, y: -8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.18 }}
        className="glass-strong flex h-full w-full max-w-[540px] flex-col overflow-hidden rounded-[22px]"
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5" style={{ WebkitAppRegion: "drag" } as React.CSSProperties}>
          <BrainCircuit className="h-4 w-4 text-memory" aria-hidden="true" />
          <span className="whitespace-nowrap text-xs font-semibold uppercase tracking-wide">On-Call Copilot</span>
          <span className="ml-1 hidden min-w-0 truncate text-[11px] text-muted sm:inline">Your team's memory, one shortcut away</span>
          <div className="ml-auto flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <button
              type="button"
              role="switch"
              aria-checked={memoryOn}
              disabled={phase === "investigating"}
              onClick={() => setMemoryOn((v) => !v)}
              className={`whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] ${memoryOn ? "bg-memory/15 text-memory" : "bg-surface text-muted"}`}
              title="Memory on uses Hindsight; memory off answers from the current context only"
            >
              MEMORY {memoryOn ? "ON" : "OFF"}
            </button>
            {desktop && (
              <button type="button" onClick={() => desktop?.hide()} aria-label="Close" className="rounded p-1 text-muted hover:bg-surface hover:text-ink">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {phase === "idle" && (
            <p className="text-sm text-muted">Press {shortcut} to investigate your current engineering context.</p>
          )}

          {phase === "context" && (
            <div className="space-y-4">
              <p className="text-xs uppercase tracking-wide text-muted">Reading current context</p>
              <ul className="space-y-2.5">
                <Check state={activation?.window ? "ok" : "missing"}>
                  <p className="flex items-center gap-1.5 text-ink">
                    <AppWindow className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                    {windowLabel ? `Active application: ${windowLabel}` : desktop ? "Active application not available" : "Active application is only visible in the desktop app"}
                  </p>
                  {activation?.window?.title && <p className="truncate text-[11px] text-muted">{activation.window.title}</p>}
                </Check>
                <Check state={projects === null ? "running" : project ? "ok" : "missing"}>
                  {project ? (
                    <div className="space-y-1">
                      <p className="flex items-center gap-1.5 text-ink">
                        <FolderOpen className="h-3.5 w-3.5 text-muted" aria-hidden="true" /> Project: {project.name}
                        <span className="rounded bg-surface px-1 text-[10px] text-muted">{project.scope === "always" ? "always allowed" : "allowed once"}</span>
                      </p>
                      <p className="truncate font-mono text-[10px] text-muted">{project.root_path}</p>
                      {context && (
                        <p className="text-[11px] text-muted">
                          {context.files_indexed} files readable{context.git ? ` · branch ${context.git.branch}` : ""}
                        </p>
                      )}
                      {(projects?.length ?? 0) > 1 && (
                        <select
                          value={project.id}
                          onChange={(e) => {
                            setProjectId(Number(e.target.value));
                            storeProject(Number(e.target.value));
                          }}
                          className="rounded glass-well px-1.5 py-0.5 text-[11px] text-ink"
                        >
                          {projects?.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-ink">No project connected</span>
                      {desktop ? (
                        <button
                          type="button"
                          onClick={() => void connectProject()}
                          className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-ink hover:border-memory/50"
                        >
                          <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" /> Connect project
                        </button>
                      ) : (
                        <span className="text-[11px] text-muted">Projects are connected from the desktop app</span>
                      )}
                    </div>
                  )}
                </Check>
                <Check state={source ? "ok" : project && !context && !contextError ? "running" : "missing"}>
                  {source ? (
                    <p className="flex items-center gap-1.5 text-ink">
                      {source.kind === "clipboard" ? (
                        <ClipboardPaste className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                      ) : source.kind === "screen" ? (
                        <MonitorUp className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                      ) : (
                        <ScrollText className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                      )}
                      {source.label}
                    </p>
                  ) : (
                    <p className="text-ink">No recent error found in the clipboard or project logs</p>
                  )}
                </Check>
              </ul>
              {contextError && <p className="text-xs text-severity">{contextError}</p>}

              {source ? (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg glass-well p-2.5 font-mono text-[11px] leading-4 text-ink">
                  {source.text}
                </pre>
              ) : (
                <textarea
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="Paste the error, alert or log lines"
                  rows={5}
                  className="w-full resize-none rounded-lg glass-well p-2.5 font-mono text-[11px] leading-4 text-ink placeholder:text-muted/60"
                />
              )}
              {desktop && (
                <button
                  type="button"
                  onClick={() => void readScreen()}
                  className="flex items-center gap-1.5 text-[11px] text-muted hover:text-ink"
                >
                  <MonitorUp className="h-3.5 w-3.5" aria-hidden="true" /> Read the error from my screen instead
                </button>
              )}
              {screenStatus && <p className="text-[11px] text-muted">{screenStatus}</p>}
              {error && <p className="text-xs text-severity">{error}</p>}
              <button
                type="button"
                autoFocus
                disabled={alertText.length < 10}
                onClick={() => void investigate()}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-memory px-3 py-2 text-sm font-medium text-bg hover:bg-memory/90 disabled:opacity-40"
              >
                <Search className="h-4 w-4" aria-hidden="true" /> Investigate {memoryOn ? "with team memory" : "without memory"}
              </button>
            </div>
          )}

          {(phase === "investigating" || phase === "diagnosis") && incident && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <IncidentChip id={incident.id} tone="severity" />
                <span className="font-mono text-[11px] text-muted">{incident.service}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{incident.title}</span>
              </div>

              {memoryOn && <HindsightStrip matched={matched} steps={steps} diagnosis={diagnosis} retained={null} />}

              {phase === "investigating" && (
                <ol className="space-y-1.5">
                  {steps.map((step) => (
                    <li key={step.name} className="flex items-start gap-2 text-xs">
                      <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <span className="text-ink">{STEP_LABEL[step.name]}</span>
                        <span className="ml-2 font-mono text-[10px] text-muted">{duration(step.duration_ms)}</span>
                        <p className="text-[11px] text-muted">{step.detail}</p>
                      </div>
                    </li>
                  ))}
                  <li className="flex items-center gap-2 text-xs text-memory">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {!memoryOn
                      ? "Answering from the current context only..."
                      : steps.some((s) => s.name === "reflect")
                        ? "Verifying every citation..."
                        : steps.some((s) => s.name === "recall")
                          ? `Hindsight is reasoning over ${matched.length} related incidents...`
                          : "Searching team memory in Hindsight..."}
                    <span className="ml-auto font-mono text-[10px] text-muted">{duration(now - startedAt)}</span>
                  </li>
                </ol>
              )}

              {phase === "investigating" && liveFindings.length > 0 && <CheckHere findings={liveFindings} project={project?.name ?? null} />}

              {phase === "diagnosis" && error && !diagnosis && (
                <div className="space-y-2 rounded-md border border-severity/30 bg-severity/5 p-3">
                  <p className="flex items-center gap-1.5 text-sm text-severity">
                    <CircleAlert className="h-4 w-4" aria-hidden="true" /> {error}
                  </p>
                  <p className="text-xs text-muted">Nothing was saved. You can try again once the service is back.</p>
                </div>
              )}

              {phase === "diagnosis" && diagnosis && (
                <div className="space-y-3">
                  {diagnosis.degraded ? (
                    <div className="space-y-2 rounded-md border border-border p-3 text-sm text-ink">
                      <p className="text-xs text-amber-300">The language model was unavailable; this is Hindsight's answer as text.</p>
                      <MarkdownLite text={diagnosis.summary} />
                    </div>
                  ) : (
                    <>
                      <p className="flex items-center gap-1.5 text-sm font-medium">
                        {!diagnosis.memory_enabled ? (
                          <span className="text-muted">Without memory: generic analysis of the current context</span>
                        ) : diagnosis.strong_match ? (
                          <>
                            <ShieldCheck className="h-4 w-4 text-memory" aria-hidden="true" />
                            <span className="text-memory">I've seen this before.</span>
                          </>
                        ) : (
                          <>
                            <ShieldQuestion className="h-4 w-4 text-amber-300" aria-hidden="true" />
                            <span className="text-amber-300">No strong precedent in memory.</span>
                          </>
                        )}
                      </p>
                      <p className={`text-sm leading-6 ${diagnosis.memory_enabled ? "text-ink" : "text-muted"}`}>
                        <LinkedText text={diagnosis.summary} />
                      </p>

                      {diagnosis.try_first && (
                        <div className={`space-y-1.5 rounded-md border p-3 ${diagnosis.memory_enabled ? "border-success/30 bg-success/5" : "border-border"}`}>
                          <p className={`text-[11px] font-semibold uppercase tracking-wide ${diagnosis.memory_enabled ? "text-success" : "text-muted"}`}>Try first</p>
                          <p className="text-sm text-ink">{diagnosis.try_first.action}</p>
                          {diagnosis.try_first.evidence.length > 0 && (
                            <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
                              Worked in {diagnosis.try_first.evidence.length} incident{diagnosis.try_first.evidence.length === 1 ? "" : "s"}:
                              {diagnosis.try_first.evidence.map((id) => (
                                <IncidentChip key={id} id={id} tone="success" />
                              ))}
                            </p>
                          )}
                        </div>
                      )}

                      {diagnosis.avoid.length > 0 && (
                        <div className="space-y-2 rounded-md border border-severity/30 bg-severity/5 p-3">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-severity">Avoid: failed before</p>
                          {diagnosis.avoid.map((item) => (
                            <div key={item.action} className="space-y-0.5">
                              <p className="flex items-start gap-1.5 text-sm text-ink">
                                <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-severity" aria-hidden="true" /> {item.action}
                              </p>
                              <p className="flex flex-wrap items-center gap-1 pl-5 text-[11px] text-muted">
                                Failed in {item.evidence.length} incident{item.evidence.length === 1 ? "" : "s"}:
                                {item.evidence.map((id) => (
                                  <IncidentChip key={id} id={id} tone="severity" />
                                ))}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}

                      <CheckHere findings={findings} project={diagnosis.project} />

                      {diagnosis.memory_enabled && (
                        <div className="rounded-md border border-border">
                          <button
                            type="button"
                            onClick={() => setWhyOpen((v) => !v)}
                            className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-ink"
                          >
                            {whyOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                            Why this? Known, likely and unknown
                          </button>
                          <AnimatePresence initial={false}>
                            {whyOpen && (
                              <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.18 }}
                                className="space-y-3 overflow-hidden px-3 pb-3 text-xs"
                              >
                                <div>
                                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-success">Known</p>
                                  <ul className="space-y-1 text-ink">
                                    {findings.map((f) => (
                                      <li key={f.path + f.line}>
                                        <span className="font-mono">{f.path}:{f.line}</span>: {f.identifier}
                                        {f.current_value !== null ? ` = ${f.current_value}` : ""}
                                      </li>
                                    ))}
                                    {diagnosis.avoid.map((a) => (
                                      <li key={a.action}>
                                        "{a.action}" failed in <LinkedText text={a.evidence.join(", ")} />
                                      </li>
                                    ))}
                                    {diagnosis.try_first && diagnosis.try_first.evidence.length > 0 && (
                                      <li>
                                        The recommended fix worked in <LinkedText text={diagnosis.try_first.evidence.join(", ")} />
                                      </li>
                                    )}
                                    {findings.length === 0 && diagnosis.cited_incidents.length === 0 && <li className="text-muted">Nothing verified yet.</li>}
                                  </ul>
                                </div>
                                {diagnosis.hypotheses.length > 0 && (
                                  <div>
                                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">Likely</p>
                                    <ul className="space-y-1 text-ink">
                                      {diagnosis.hypotheses.map((h) => (
                                        <li key={h.cause}>
                                          {h.cause} <span className="font-mono text-muted">({percent(h.confidence)})</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {diagnosis.unknowns.length > 0 && (
                                  <div>
                                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Unknown</p>
                                    <ul className="space-y-1 text-muted">
                                      {diagnosis.unknowns.map((u) => (
                                        <li key={u}>{u}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                <div>
                                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-memory">Related incidents</p>
                                  <ul className="space-y-1">
                                    {diagnosis.matched.slice(0, 5).map((m) => (
                                      <li key={m.id} className="flex items-center gap-2">
                                        <IncidentChip id={m.id} tone={diagnosis.cited_incidents.includes(m.id) ? "memory" : "muted"} />
                                        <span className="font-mono text-muted">{percent(m.relevance)}</span>
                                        <span className="truncate text-muted">{dateWithAge(m.occurred_at)}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      )}
                    </>
                  )}

                  <div className="space-y-2 border-t border-border pt-3">
                    <p className="text-xs text-muted">Did this resolve the issue?</p>
                    {tried ? (
                      <p className={`text-xs ${tried.outcome === "worked" ? "text-success" : "text-severity"}`}>
                        Recorded: {tried.outcome === "worked" ? "worked" : "did not work"}{tried.memory_retained ? ", saved to Hindsight" : ""}.
                      </p>
                    ) : (
                      diagnosis.try_first && (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void record(diagnosis.try_first?.action ?? "", "worked")}
                            className="flex items-center gap-1.5 rounded-md border border-success/40 px-2.5 py-1 text-xs text-success hover:bg-success/10"
                          >
                            <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" /> Worked
                          </button>
                          <button
                            type="button"
                            onClick={() => void record(diagnosis.try_first?.action ?? "", "failed")}
                            className="flex items-center gap-1.5 rounded-md border border-severity/40 px-2.5 py-1 text-xs text-severity hover:bg-severity/10"
                          >
                            <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" /> Didn't work
                          </button>
                          <button
                            type="button"
                            onClick={() => setNoteOpen((v) => !v)}
                            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-ink hover:border-memory/50"
                          >
                            <NotebookPen className="h-3.5 w-3.5" aria-hidden="true" /> Note
                          </button>
                        </div>
                      )
                    )}
                    {(noteOpen || !diagnosis.try_first) && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (note.trim().length < 3) return;
                          void record(note.trim(), noteOutcome).then(() => setNote(""));
                        }}
                        className="flex gap-2"
                      >
                        <input
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="What did you try?"
                          className="min-w-0 flex-1 rounded-lg glass-well px-2 py-1 text-xs text-ink placeholder:text-muted/60"
                        />
                        <select
                          value={noteOutcome}
                          onChange={(e) => setNoteOutcome(e.target.value as Outcome)}
                          className="rounded-lg glass-well px-1.5 text-xs text-ink"
                        >
                          <option value="failed">Failed</option>
                          <option value="worked">Worked</option>
                          <option value="partial">Partial</option>
                        </select>
                        <button type="submit" className="rounded-md border border-border px-2 text-xs text-ink hover:border-memory/50">
                          Log
                        </button>
                      </form>
                    )}
                    {attempts.length > 0 && (
                      <ul className="space-y-0.5">
                        {attempts.map((a) => (
                          <li key={a.id} className="flex items-center gap-1.5 text-[11px] text-muted">
                            {a.outcome === "worked" ? (
                              <CircleCheck className="h-3 w-3 text-success" aria-hidden="true" />
                            ) : (
                              <CircleAlert className="h-3 w-3 text-severity" aria-hidden="true" />
                            )}
                            {a.action}
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      type="button"
                      onClick={() => void openResolve()}
                      className="flex w-full items-center justify-center gap-2 rounded-md border border-memory/50 px-3 py-2 text-sm text-memory hover:bg-memory/10"
                    >
                      <BrainCircuit className="h-4 w-4" aria-hidden="true" /> Resolve and learn
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {phase === "resolve" && incident && (
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted">
                Resolve <span className="font-mono text-memory">{incident.id}</span>
              </p>
              {!draft ? (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Drafting the postmortem from this session...
                </p>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void resolveAndLearn();
                  }}
                  className="space-y-3"
                >
                  <label className="flex flex-col gap-1 text-xs text-muted">
                    Root cause
                    <textarea
                      rows={3}
                      value={draft.root_cause}
                      onChange={(e) => setDraft({ ...draft, root_cause: e.target.value })}
                      className="resize-none rounded-lg glass-well p-2 text-xs leading-5 text-ink"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted">
                    Action taken
                    <textarea
                      rows={2}
                      value={draft.fix}
                      onChange={(e) => setDraft({ ...draft, fix: e.target.value })}
                      className="resize-none rounded-lg glass-well p-2 text-xs leading-5 text-ink"
                    />
                  </label>
                  <fieldset className="flex items-center gap-4 text-xs text-ink">
                    <legend className="mb-1 text-muted">Outcome</legend>
                    {(["worked", "failed"] as Outcome[]).map((value) => (
                      <label key={value} className="flex items-center gap-1.5">
                        <input type="radio" name="outcome" checked={resolveOutcome === value} onChange={() => setResolveOutcome(value)} />
                        {value === "worked" ? "Worked" : "Failed"}
                      </label>
                    ))}
                  </fieldset>
                  <label className="flex flex-col gap-1 text-xs text-muted">
                    Notes
                    <textarea
                      rows={2}
                      value={draft.summary}
                      onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                      className="resize-none rounded-lg glass-well p-2 text-xs leading-5 text-ink"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-ink">
                    <input type="checkbox" checked={saveExperience} onChange={(e) => setSaveExperience(e.target.checked)} />
                    Save as engineering experience in Hindsight
                  </label>
                  <button
                    type="submit"
                    disabled={saving || draft.fix.trim().length < 3 || draft.root_cause.trim().length < 5}
                    className="flex w-full items-center justify-center gap-2 rounded-md bg-memory px-3 py-2 text-sm font-medium text-bg hover:bg-memory/90 disabled:opacity-40"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
                    {saving ? "Saving to Hindsight..." : "Resolve and learn"}
                  </button>
                </form>
              )}
              {error && <p className="text-xs text-severity">{error}</p>}
            </div>
          )}

          {phase === "learned" && experience && incident && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-memory">
                <BrainCircuit className="h-4 w-4" aria-hidden="true" /> Experience captured
              </p>
              <ul className="space-y-1.5 text-xs">
                <Check state="ok">Incident {incident.id} resolved</Check>
                <Check state={attempts.length ? "ok" : "missing"}>
                  {attempts.length} outcome{attempts.length === 1 ? "" : "s"} recorded ({attempts.filter((a) => a.outcome === "worked").length} worked,{" "}
                  {attempts.filter((a) => a.outcome === "failed").length} failed)
                </Check>
                <Check state={experience.memory_retained ? "ok" : "missing"}>
                  {experience.memory_retained
                    ? `Postmortem retained in Hindsight (memory ${experience.memory_count_before} to ${experience.memory_count_after})`
                    : saveExperience
                      ? "Hindsight was unavailable, so memory was not updated"
                      : "Not saved to memory (you chose not to)"}
                </Check>
              </ul>
              <div className="space-y-1 rounded-md border border-border p-3 text-xs">
                <p className="text-muted">Pattern</p>
                <p className="text-ink">
                  <LinkedText text={experience.pattern} />
                </p>
                <p className="pt-1 text-muted">Worked</p>
                {experience.worked_fixes.map((f) => (
                  <p key={f} className="text-ink">{f}</p>
                ))}
                {experience.failed_fixes.length > 0 && <p className="pt-1 text-muted">Failed</p>}
                {experience.failed_fixes.map((f) => (
                  <p key={f} className="text-ink">{f}</p>
                ))}
              </div>
              <p className="text-xs text-muted">The next similar incident will recall this.</p>
              {desktop && (
                <button
                  type="button"
                  onClick={() => desktop?.openConsole(`/incidents/${incident.id}`)}
                  className="text-xs text-memory hover:underline"
                >
                  Open {incident.id} in the console
                </button>
              )}
            </motion.div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
