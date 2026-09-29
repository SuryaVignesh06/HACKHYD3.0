import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, Check, ChevronLeft, CircleAlert, CircleCheck, Code2, Loader2, Mic, PenLine, RotateCcw, ScanSearch, Square, Undo2, X } from "lucide-react";
import { ModeLine } from "../components/DiagnosisCard";
import { IncidentChip, LinkedText } from "../components/IncidentPeek";
import MarkdownLite from "../components/MarkdownLite";
import Orb, { ORB } from "../components/Orb";
import ResultView, { PastIncidentList } from "../components/ResultView";
import { Kbd, Switch } from "../components/ui";
import { api, streamDiagnosis } from "../lib/api";
import { desktop, looksLikeError, shortcutLabel, type Activation, type IdeContext } from "../lib/desktop";
import { duration } from "../lib/format";
import { useVoice } from "../lib/voice";
import type {
  AskAnswer,
  AttemptLogged,
  Diagnosis,
  ExperienceCaptured,
  IncidentCreated,
  InvestigationStep,
  MatchedIncident,
  Outcome,
  PostmortemDraft,
  ProjectOut,
  StreamEvent,
} from "../lib/types";

type Phase = "consent" | "reading" | "found" | "home" | "working" | "diagnosis" | "answer" | "resolve" | "learned";
type Intent = "investigate" | "ask";
type Finding = { kind: "screen" | "logs" | "clipboard"; title: string; label: string; text: string };
/** What the engineer reports after applying the fix. "reverted" is stored as a failed attempt with a note. */
type Reported = "worked" | "partial" | "failed" | "reverted";

const PROJECT_KEY = "oncall.overlay.project";
const MIN_READING_MS = 1100; // keep the edge waves on long enough to register, even when OCR is instant

const REPORTED: { value: Reported; label: string; icon: JSX.Element; tone: string }[] = [
  { value: "worked", label: "Worked", icon: <Check className="h-3.5 w-3.5" aria-hidden="true" />, tone: "btn-success" },
  { value: "partial", label: "Partly", icon: <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />, tone: "btn-amber" },
  { value: "failed", label: "Didn't work", icon: <X className="h-3.5 w-3.5" aria-hidden="true" />, tone: "btn-danger" },
  { value: "reverted", label: "Reverted", icon: <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />, tone: "btn-secondary" },
];

const STEP_LABEL: Record<string, string> = {
  parse: "Read the error",
  recall: "Searched team memory",
  evidence: "Compared what worked and failed",
  inspect: "Inspected your project",
  reflect: "Reasoned over past incidents",
  diagnosis: "Verified every citation",
};

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

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

/** The first line of captured text that reads like an error. */
function errorLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /\b\w*(Error|Exception)\b:|Too many connections|OOMKilled|x509|timeout|refused/i.test(l)) ?? lines[0] ?? "";
  return hit.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+\S*\s+(ERROR|WARN\w*|FATAL|CRITICAL)?\s*/, "").slice(0, 140);
}

function IdeLine({ ide }: { ide: IdeContext }) {
  return (
    <p className="flex max-w-full items-center justify-center gap-1.5 truncate text-xs text-muted">
      <Code2 className="h-3.5 w-3.5 shrink-0 text-memory" aria-hidden="true" />
      <span className="text-ink">{ide.ide}</span>
      {ide.folder && <span className="truncate">· {ide.folder}</span>}
      {ide.file && <span className="truncate font-mono">· {ide.file}</span>}
    </p>
  );
}

export default function Overlay() {
  const [phase, setPhase] = useState<Phase>(desktop ? "consent" : "home");
  const [openKey, setOpenKey] = useState(0);
  const [closing, setClosing] = useState(false);
  const [activation, setActivation] = useState<Activation | null>(null);
  const [projects, setProjects] = useState<ProjectOut[] | null>(null);
  const [projectId, setProjectId] = useState<number | null>(readStoredProject());
  const [fallback, setFallback] = useState<Finding | null>(null);
  const [finding, setFinding] = useState<Finding | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [forced, setForced] = useState<Intent | null>(null);
  const [memoryOn, setMemoryOn] = useState(true);
  const [incident, setIncident] = useState<IncidentCreated | null>(null);
  const [working, setWorking] = useState<{ kind: Intent; text: string } | null>(null);
  const [steps, setSteps] = useState<InvestigationStep[]>([]);
  const [matched, setMatched] = useState<MatchedIncident[]>([]);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [attempts, setAttempts] = useState<AttemptLogged[]>([]);
  const [sheet, setSheet] = useState<Reported | null>(null);
  const [action, setAction] = useState("");
  const [notes, setNotes] = useState("");
  const [recording, setRecording] = useState(false);
  const [draft, setDraft] = useState<PostmortemDraft | null>(null);
  const [saveExperience, setSaveExperience] = useState(true);
  const [saving, setSaving] = useState(false);
  const [experience, setExperience] = useState<ExperienceCaptured | null>(null);
  const [showRetained, setShowRetained] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const sheetInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const voice = useVoice((text) => setComposer((c) => (c.trim() ? `${c.trim()} ${text}` : text)));
  const project = projects?.find((p) => p.id === projectId) ?? null;
  const shortcut = shortcutLabel(desktop?.shortcut ?? "Control+Space");
  const intent: Intent = forced ?? (looksLikeError(composer) ? "investigate" : "ask");
  const ide = activation?.ide ?? null;
  const ideProject = ide?.folderPath ? projects?.find((p) => samePath(p.root_path, ide.folderPath!)) ?? null : null;
  const needsFolderConsent = Boolean(desktop?.authorizeFolder && ide?.folderPath && projects !== null && !ideProject);

  // The desktop window is an acrylic surface; the page itself stays transparent so the OS blur shows through.
  useEffect(() => {
    if (!desktop) return;
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
  }, []);

  const loadProjects = useCallback(async (): Promise<ProjectOut[]> => {
    const result = await api.projects();
    const list = result.ok ? result.data : [];
    setProjects(list);
    setProjectId((current) => (current && list.some((p) => p.id === current) ? current : list.length ? list[list.length - 1]!.id : null));
    return list;
  }, []);

  /** Errors the agent can offer without the screen: the clipboard, or recent errors in the project's logs. */
  const loadFallback = useCallback(async (id: number | null, clipboard: string) => {
    if (looksLikeError(clipboard)) {
      setFallback({ kind: "clipboard", title: "Your clipboard has an error", label: "From your clipboard", text: clipboard.trim() });
      return;
    }
    setFallback(null);
    if (id === null) return;
    const result = await api.projectContext(id);
    const logs = result.ok ? result.data.log_errors : null;
    if (result.ok && logs) {
      setFallback({
        kind: "logs",
        title: `${logs.error_count} recent error${logs.error_count === 1 ? "" : "s"} in your logs`,
        label: `${result.data.project.name}/${logs.path}`,
        text: `[LOG] recent errors in ${result.data.project.name}/${logs.path}\n${logs.lines.join("\n")}`,
      });
    }
  }, []);

  const reset = useCallback(
    (payload: Activation | null) => {
      abort.current?.abort();
      setPhase(desktop?.readScreen ? "consent" : "home");
      setIncident(null);
      setWorking(null);
      setSteps([]);
      setMatched([]);
      setDiagnosis(null);
      setAnswer(null);
      setError(null);
      setNotice(null);
      setFinding(null);
      setAttempts([]);
      setSheet(null);
      setAction("");
      setNotes("");
      setDraft(null);
      setExperience(null);
      setShowRetained(false);
      setComposer("");
      setForced(null);
      void loadProjects().then((list) => {
        const detected = payload?.ide?.folderPath;
        const match = detected ? list.find((p) => samePath(p.root_path, detected)) : undefined;
        const id = match?.id ?? projectRef.current ?? (list.length ? list[list.length - 1]!.id : null);
        if (match) setProjectId(match.id);
        void loadFallback(id, payload?.clipboard ?? "");
      });
    },
    [loadProjects, loadFallback],
  );

  // Every shortcut press replays the pop-in. An open incident is kept so the engineer can come back from the editor.
  const onActivated = useCallback(
    (payload: Activation) => {
      setActivation(payload);
      setClosing(false);
      setOpenKey((k) => k + 1);
      const keep = phaseRef.current === "diagnosis" || phaseRef.current === "resolve" || phaseRef.current === "working";
      if (!keep) reset(payload);
    },
    [reset],
  );

  useEffect(() => {
    if (desktop) return desktop.onActivated(onActivated);
    onActivated({ window: null, clipboard: "", at: new Date().toISOString(), openedInMs: 0 });
    return undefined;
  }, [onActivated]);

  const stopVoice = voice.stop;
  const dismiss = useCallback(() => {
    stopVoice();
    if (desktop) setClosing(true);
  }, [stopVoice]);

  useEffect(() => desktop?.onDismiss?.(dismiss), [dismiss]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('[role="dialog"]')) return;
      if (sheet) setSheet(null);
      else dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss, sheet]);

  useEffect(() => {
    if (phase !== "working") return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase === "home" || phase === "answer") window.setTimeout(() => composerRef.current?.focus({ preventScroll: true }), 120);
  }, [phase]);

  /** Yes: allow the IDE folder if needed (native dialog), then read the screen once, with the edge waves on. */
  async function readScreenNow() {
    if (!desktop?.readScreen) return;
    setNotice(null);
    setPhase("reading");
    if (needsFolderConsent && ide?.folderPath && desktop.authorizeFolder) {
      const allowed = await desktop.authorizeFolder(ide.folderPath);
      if ("project" in allowed) {
        storeProject(allowed.project.id);
        setProjectId(allowed.project.id);
        await loadProjects();
      }
    } else if (ideProject) {
      setProjectId(ideProject.id);
    }
    const started = Date.now();
    const reading = await desktop.readScreen();
    const wait = MIN_READING_MS - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (reading.ok && reading.found) {
      setFinding({ kind: "screen", title: "I found this on your screen", label: `Read on this computer in ${duration(reading.ms)}, not saved`, text: reading.text });
      setPhase("found");
    } else if (fallback) {
      setFinding({ ...fallback, title: reading.ok ? `Nothing on screen, but ${fallback.title.charAt(0).toLowerCase()}${fallback.title.slice(1)}` : fallback.title });
      setNotice(reading.ok ? null : reading.message ?? null);
      setPhase("found");
    } else {
      setNotice(reading.ok ? `I read ${reading.lineCount} lines on your screen but none looked like an error. Paste it or describe it below.` : reading.message ?? "Screen reading failed.");
      setPhase("home");
    }
  }

  async function investigate(alertText: string, origin: string) {
    if (alertText.trim().length < 10) {
      setError("Paste a little more of the error so there is something to investigate.");
      return;
    }
    voice.stop();
    setError(null);
    const created = await api.createIncident({ alert_text: alertText, ...(project ? { project_id: project.id } : {}), origin });
    if (!created.ok) {
      setError(created.error.message);
      return;
    }
    setIncident(created.data);
    setWorking({ kind: "investigate", text: alertText });
    setSteps([]);
    setMatched([]);
    setPhase("working");
    setStartedAt(Date.now());
    const controller = new AbortController();
    abort.current = controller;
    await streamDiagnosis(
      created.data.id,
      memoryOn,
      (event: StreamEvent) => {
        if (event.type === "step") {
          setSteps((s) => [...s, event.step]);
          if (event.step.name === "recall" && Array.isArray(event.data.matched)) setMatched(event.data.matched as MatchedIncident[]);
        } else if (event.type === "diagnosis") {
          setDiagnosis(event.diagnosis);
          setAction(event.diagnosis.try_first?.action ?? "");
          setPhase("diagnosis");
        } else {
          setError(event.message);
          setPhase("diagnosis");
        }
      },
      controller.signal,
    );
  }

  async function ask(question: string) {
    if (question.trim().length < 3) return;
    voice.stop();
    setError(null);
    setWorking({ kind: "ask", text: question.trim() });
    setPhase("working");
    setStartedAt(Date.now());
    const result = await api.ask(question.trim());
    if (result.ok) {
      setAnswer(result.data);
      setComposer("");
      setForced(null);
      setPhase("answer");
    } else {
      setError(result.error.message);
      setPhase(answer ? "answer" : "home");
    }
  }

  function submit() {
    const text = composer.trim();
    if (!text) return;
    if (intent === "investigate") void investigate(text, "manual");
    else if (memoryOn) void ask(text);
  }

  async function record(what: string, outcome: Outcome, note = ""): Promise<AttemptLogged | null> {
    if (!incident) return null;
    const result = await api.logAttempt(incident.id, { action: what, outcome, ...(note ? { notes: note } : {}) });
    if (result.ok) {
      setAttempts((a) => [...a, result.data]);
      return result.data;
    }
    setError(result.error.message);
    return null;
  }

  async function saveOutcome() {
    if (!sheet || action.trim().length < 3 || recording) return;
    setRecording(true);
    const outcome: Outcome = sheet === "reverted" ? "failed" : sheet;
    const note = [sheet === "reverted" ? "Applied, then reverted." : "", notes.trim()].filter(Boolean).join(" ");
    const logged = await record(action.trim(), outcome, note);
    setRecording(false);
    if (!logged) return;
    setSheet(null);
    setNotes("");
    if (outcome === "worked" || outcome === "partial") {
      await openResolve(logged.action);
    } else {
      setAction("");
      setNotice(logged.memory_retained ? "Saved to memory. The next engineer will be warned before trying this." : "Saved locally; Hindsight was unavailable.");
    }
  }

  async function openResolve(fixAction?: string) {
    if (!incident) return;
    setPhase("resolve");
    const worked = attempts.find((a) => a.outcome === "worked");
    const fix = fixAction ?? worked?.action ?? diagnosis?.try_first?.action ?? "";
    const result = await api.postmortemDraft(incident.id);
    if (result.ok) setDraft({ ...result.data, fix: fix || result.data.fix });
    else setDraft({ summary: incident.title, root_cause: diagnosis?.hypotheses[0]?.cause ?? "", fix, follow_ups: [], ttr_minutes: 1, drafted_by: "session" });
  }

  async function resolveAndLearn() {
    if (!incident || !draft || saving) return;
    setSaving(true);
    setError(null);
    if (!attempts.some((a) => a.action === draft.fix)) await record(draft.fix, "worked", "recorded when resolving");
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

  // ------------------------------------------------------------------ derived view state

  const recallStep = steps.find((s) => s.name === "recall");
  const unavailable = Boolean(recallStep?.detail.startsWith("Hindsight unavailable") || diagnosis?.memory_unavailable || answer?.memory_unavailable);
  const orbState = voice.listening
    ? ORB.listening
    : phase === "working" || phase === "reading"
      ? ORB.thinking
      : phase === "learned" && experience?.memory_retained
        ? ORB.success
        : unavailable || (phase === "diagnosis" && error && !diagnosis)
          ? ORB.warning
          : !memoryOn
            ? ORB.off
            : ORB.idle;
  const workingText =
    working?.kind === "ask"
      ? "Searching your team's memory..."
      : !memoryOn
        ? "Thinking about this error..."
        : unavailable
          ? "Memory is unavailable, answering from the error alone..."
          : !recallStep
            ? "Searching engineering memory..."
            : !steps.some((s) => s.name === "inspect")
              ? `I found ${matched.length} related incident${matched.length === 1 ? "" : "s"}. Comparing what worked...`
              : !steps.some((s) => s.name === "reflect")
                ? "Checking your project..."
                : "Verifying every citation...";
  const affectedFile = diagnosis?.findings[0] ? `${diagnosis.findings[0].path}:${diagnosis.findings[0].line}` : null;
  const answerCited = answer ? Array.from(new Set(answer.answer.match(/\bINC-\d{3,}\b/g) ?? [])) : [];
  const learnedHere = diagnosis?.matched.find((m) => m.learned_live && diagnosis.cited_incidents.includes(m.id));
  const wide = phase === "diagnosis" || phase === "answer" || phase === "resolve" || phase === "working" || phase === "learned";
  const showComposer = phase === "home" || phase === "answer";
  const showHeader = phase !== "consent" && phase !== "reading";

  const headline = diagnosis ? (
    diagnosis.memory_unavailable ? (
      <span className="text-amber-300">Memory unavailable</span>
    ) : !diagnosis.memory_enabled ? (
      <span className="text-muted">Answer without memory</span>
    ) : learnedHere ? (
      <span className="text-memory">I remember this one.</span>
    ) : diagnosis.strong_match ? (
      <span className="text-memory">I've seen this before.</span>
    ) : (
      <span className="text-amber-300">Nothing quite like this yet.</span>
    )
  ) : null;

  // ------------------------------------------------------------------ view

  return (
    <div
      className={desktop ? "relative flex h-screen w-screen flex-col overflow-hidden select-none bg-transparent" : "fixed inset-0 flex items-center justify-center p-6 bg-black/60 backdrop-blur-md"}
      onMouseDown={(e) => {
        if (!desktop && e.target === e.currentTarget && !sheet) dismiss();
      }}
    >
      <AnimatePresence>
        {phase === "reading" && (
          <motion.div key="glow" className="screen-glow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
            <span />
            <span />
            <span />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div
        key={openKey}
        layout
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={closing ? { opacity: 0, scale: 0.94, y: 8 } : { opacity: 1, scale: 1, y: 0 }}
        transition={closing ? { duration: 0.15, ease: [0.4, 0, 1, 1] } : { type: "spring", stiffness: 380, damping: 22, mass: 0.8 }}
        onAnimationComplete={() => {
          if (closing) desktop?.hide();
        }}
        className={`glass-strong glass-fluid relative flex flex-col overflow-hidden rounded-[26px] border border-white/[0.14] shadow-[0_24px_80px_rgba(0,0,0,0.85)] bg-[#101010]/85 ${
          desktop ? "h-full w-full" : `max-h-[86vh] w-full ${wide ? "max-w-[500px]" : "max-w-[420px]"}`
        }`}
      >
        {showHeader && (
          <header
            className="flex shrink-0 items-center gap-2 px-4 pb-1 pt-3.5 select-none"
            style={{ WebkitAppRegion: desktop ? "drag" : "no-drag" } as React.CSSProperties}
          >
            {phase !== "home" && (
              <button
                type="button"
                onClick={() => reset(activation)}
                className="btn btn-ghost !px-2 !py-1 text-xs"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                title="Start over"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" /> New
              </button>
            )}
            <div
              className="ml-auto flex items-center gap-1.5"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <label className="flex items-center gap-2 rounded-full bg-white/[0.05] py-1 pl-2.5 pr-1 text-[11px]" title="Memory on uses Hindsight; off answers from the error alone">
                <span className={memoryOn ? "text-memory" : "text-muted"}>Memory</span>
                <Switch on={memoryOn} onChange={setMemoryOn} label="Use team memory" disabled={phase === "working"} />
              </label>
              {desktop && (
                <button type="button" onClick={dismiss} aria-label="Close" className="btn btn-ghost !p-1.5">
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </header>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
          <AnimatePresence mode="wait" initial={false}>
            {phase === "consent" && (
              <motion.div key="consent" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="flex flex-col items-center pt-6 text-center">
                <motion.div initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 13, delay: 0.05 }}>
                  <Orb size={112} density={80} {...orbState} />
                </motion.div>
                <h1 className="mt-3 text-xl font-semibold tracking-tight">Want me to read your screen?</h1>
                <p className="mt-1.5 max-w-[320px] text-sm text-muted">I'll look for the error you're seeing. It's read on this computer, once, and never saved.</p>
                {ide && (
                  <div className="mt-4 w-full">
                    <IdeLine ide={ide} />
                    {needsFolderConsent && <p className="mt-1 text-[11px] text-muted">I'll also ask to read the {ide.folder} folder.</p>}
                  </div>
                )}
                <div className="mt-6 flex w-full gap-2">
                  <button type="button" onClick={() => setPhase("home")} className="btn btn-secondary btn-lg flex-1">
                    Not now
                  </button>
                  <button type="button" autoFocus onClick={() => void readScreenNow()} className="btn btn-primary btn-lg flex-1">
                    <ScanSearch className="h-4 w-4" aria-hidden="true" /> Read my screen
                  </button>
                </div>
              </motion.div>
            )}

            {phase === "reading" && (
              <motion.div key="reading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="flex flex-col items-center py-7 text-center">
                <Orb size={128} density={90} {...orbState} />
                <p className="mt-3 text-lg font-semibold tracking-tight">Reading your screen...</p>
                <p className="mt-1 text-sm text-muted">{ide ? `Looking at ${ide.ide}${ide.folder ? ` · ${ide.folder}` : ""}` : "Looking for the error"}</p>
              </motion.div>
            )}

            {phase === "found" && finding && (
              <motion.div key="found" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="flex flex-col items-center pt-2 text-center">
                <Orb size={84} density={60} {...orbState} />
                <p className="mt-2 text-lg font-semibold tracking-tight">{finding.title}</p>
                <pre className="glass-well mt-3 max-h-44 w-full overflow-auto whitespace-pre-wrap rounded-2xl p-3 text-left font-mono text-[11px] leading-[1.55] text-severity">
                  {finding.text}
                </pre>
                <p className="mt-2 text-[11px] text-muted">{finding.label}</p>
                {notice && <p className="mt-1 text-[11px] text-amber-300">{notice}</p>}
                {error && <p className="mt-2 text-xs text-severity">{error}</p>}
                <div className="mt-5 flex w-full gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setComposer(finding.text);
                      setPhase("home");
                    }}
                    className="btn btn-secondary btn-lg"
                  >
                    <PenLine className="h-4 w-4" aria-hidden="true" /> Edit
                  </button>
                  <button type="button" autoFocus onClick={() => void investigate(finding.text, finding.kind)} className="btn btn-primary btn-lg flex-1">
                    Investigate
                  </button>
                </div>
              </motion.div>
            )}

            {phase === "home" && (
              <motion.div key="home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="flex flex-col items-center pt-1 text-center">
                <Orb size={96} density={70} {...orbState} level={voice.level} />
                <h1 className="mt-2 text-xl font-semibold tracking-tight">{voice.listening ? "Listening..." : voice.starting ? "Starting the microphone..." : "How can I help?"}</h1>
                <p className="mt-1 max-w-[330px] text-sm text-muted">
                  {voice.partial ? <span className="text-ink">{voice.partial}</span> : "Paste an error to investigate it, or ask what your team learned before."}
                </p>
                {notice && <p className="mt-3 text-xs text-amber-300">{notice}</p>}
                {fallback && !composer && (
                  <button
                    type="button"
                    onClick={() => void investigate(fallback.text, fallback.kind)}
                    className="mt-3 flex w-full items-center gap-2 rounded-2xl border border-severity/25 bg-severity/[0.07] px-3 py-2.5 text-left transition-colors hover:bg-severity/[0.12]"
                  >
                    <CircleAlert className="h-4 w-4 shrink-0 text-severity" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] text-ink">{fallback.title}</span>
                      <span className="block truncate font-mono text-[11px] text-severity">{errorLine(fallback.text)}</span>
                    </span>
                    <span className="shrink-0 text-xs text-memory">Investigate</span>
                  </button>
                )}
              </motion.div>
            )}

            {phase === "working" && working && (
              <motion.div key="working" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="flex flex-col items-center pt-1">
                <Orb size={132} density={90} {...orbState} />
                <motion.p key={workingText} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="mt-2 text-center text-[15px] font-medium tracking-tight">
                  {workingText}
                </motion.p>
                <p className="mt-1 max-w-full truncate text-center font-mono text-[11px] text-muted">{working.kind === "ask" ? working.text : errorLine(working.text)}</p>
                {working.kind === "investigate" && (
                  <ol className="mt-4 w-full space-y-2">
                    {steps.map((step) => (
                      <motion.li key={step.name} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-start gap-2.5 text-xs">
                        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center text-ink">
                            {STEP_LABEL[step.name]}
                            <span className="ml-auto font-mono text-[10px] text-muted">{duration(step.duration_ms)}</span>
                          </p>
                          <p className="truncate text-[11px] text-muted" title={step.detail}>
                            {step.detail}
                          </p>
                        </div>
                      </motion.li>
                    ))}
                    <li className="flex items-center gap-2.5 text-xs text-memory">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Working
                      <span className="ml-auto font-mono text-[10px] text-muted">{duration(now - startedAt)}</span>
                    </li>
                  </ol>
                )}
                {matched.length > 0 && (
                  <div className="mt-3 flex flex-wrap justify-center gap-1">
                    {matched.map((m) => (
                      <IncidentChip key={m.id} id={m.id} tone={m.learned_live ? "memory" : "muted"} />
                    ))}
                  </div>
                )}
              </motion.div>
            )}

            {phase === "diagnosis" && incident && (
              <motion.div key="diagnosis" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="space-y-4 pt-1">
                {error && !diagnosis ? (
                  <div className="flex flex-col items-center gap-3 py-6 text-center">
                    <Orb size={100} density={60} {...ORB.warning} />
                    <p className="text-sm text-severity">{error}</p>
                    <p className="text-xs text-muted">Nothing was saved. Try again once the service is back.</p>
                  </div>
                ) : diagnosis ? (
                  <>
                    <div className="flex items-center gap-3">
                      <Orb size={48} density={40} scale={90} interactive={false} {...orbState} />
                      <div className="min-w-0">
                        <p className="text-lg font-semibold tracking-tight">{headline}</p>
                        <p className="flex items-center gap-1.5 text-[11px] text-muted">
                          <IncidentChip id={incident.id} tone="severity" /> <span className="truncate">{incident.title}</span>
                        </p>
                      </div>
                    </div>
                    {diagnosis.degraded ? (
                      <div className="tile text-sm text-ink">
                        <p className="mb-2 text-xs text-amber-300">The language model was unavailable; this is Hindsight's answer as text.</p>
                        <MarkdownLite text={diagnosis.summary} />
                      </div>
                    ) : (
                      <>
                        <p className="text-[14px] leading-6 text-ink">
                          <LinkedText text={diagnosis.summary} />
                        </p>
                        <ModeLine diagnosis={diagnosis} />
                        <ResultView diagnosis={diagnosis} />
                      </>
                    )}
                  </>
                ) : null}
              </motion.div>
            )}

            {phase === "answer" && answer && (
              <motion.div key={`answer-${answer.question}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="space-y-4 pt-1">
                <div className="flex items-center gap-3">
                  <Orb size={48} density={40} scale={90} interactive={false} {...orbState} />
                  <div className="min-w-0">
                    <p className="text-lg font-semibold tracking-tight text-memory">{answer.memory_unavailable ? "Memory unavailable" : "From your team's memory"}</p>
                    <p className="truncate text-[12px] text-muted">{answer.question}</p>
                  </div>
                </div>
                <div className="text-[14px] leading-6 text-ink">
                  <MarkdownLite text={answer.answer} />
                </div>
                {!answer.memory_unavailable && (
                  <p className="text-[11px] text-muted">
                    Hindsight recalled {answer.recalled_count} memories across {answer.incidents.length} incident{answer.incidents.length === 1 ? "" : "s"} in {duration(answer.latency_ms)}.
                  </p>
                )}
                {answer.incidents.length > 0 && (
                  <div className="space-y-2">
                    <p className="eyebrow">Past incidents</p>
                    <PastIncidentList items={answer.incidents} cited={answerCited} />
                  </div>
                )}
              </motion.div>
            )}

            {phase === "resolve" && incident && (
              <motion.div key="resolve" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-4 pt-1">
                <div>
                  <p className="text-lg font-semibold tracking-tight">Save what you learned</p>
                  <p className="text-sm text-muted">Check the experience before it goes into team memory.</p>
                </div>
                {!draft ? (
                  <p className="flex items-center gap-2 text-sm text-muted">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Drafting it from this session...
                  </p>
                ) : (
                  <form
                    id="resolve-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void resolveAndLearn();
                    }}
                    className="space-y-3"
                  >
                    <div className="tile grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                      <span className="text-muted">Incident</span>
                      <span className="flex min-w-0 items-center gap-2">
                        <IncidentChip id={incident.id} /> <span className="truncate text-ink">{incident.service}</span>
                      </span>
                      {affectedFile && (
                        <>
                          <span className="text-muted">File</span>
                          <span className="truncate font-mono text-ink">{affectedFile}</span>
                        </>
                      )}
                      <span className="text-muted">Tried</span>
                      <span className="text-ink">
                        {attempts.filter((a) => a.outcome === "worked").length} worked, {attempts.filter((a) => a.outcome === "partial").length} partly,{" "}
                        {attempts.filter((a) => a.outcome === "failed").length} failed
                      </span>
                    </div>
                    <label className="block space-y-1 text-[11px] text-muted">
                      Root cause
                      <textarea rows={3} value={draft.root_cause} onChange={(e) => setDraft({ ...draft, root_cause: e.target.value })} className="field resize-none text-xs leading-5" />
                    </label>
                    <label className="block space-y-1 text-[11px] text-muted">
                      What fixed it
                      <textarea rows={2} value={draft.fix} onChange={(e) => setDraft({ ...draft, fix: e.target.value })} className="field resize-none text-xs leading-5" />
                    </label>
                    <label className="block space-y-1 text-[11px] text-muted">
                      Lesson for next time
                      <textarea rows={3} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} className="field resize-none text-xs leading-5" />
                    </label>
                    <label className="flex items-center gap-2 text-xs text-ink">
                      <input type="checkbox" checked={saveExperience} onChange={(e) => setSaveExperience(e.target.checked)} className="accent-teal-500" />
                      Save to team memory (Hindsight). Secrets are redacted first.
                    </label>
                  </form>
                )}
              </motion.div>
            )}

            {phase === "learned" && experience && incident && (
              <motion.div key="learned" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 24 }} className="flex flex-col items-center gap-3 pt-1 text-center">
                <div className="relative">
                  <Orb size={120} density={80} {...orbState} />
                  {experience.memory_retained && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 300, damping: 14, delay: 0.25 }}
                      className="absolute inset-0 m-auto flex h-11 w-11 items-center justify-center rounded-full bg-black/40 ring-1 ring-success/50 backdrop-blur"
                    >
                      <Check className="h-5 w-5 text-success" aria-hidden="true" />
                    </motion.span>
                  )}
                </div>
                {experience.memory_retained ? (
                  <>
                    <p className="eyebrow !text-memory">Experience captured</p>
                    <p className="text-xl font-semibold tracking-tight">Added to your team's memory.</p>
                    <p className="text-sm text-muted">The next similar incident will start from what you just learned.</p>
                    {experience.memory_count_before !== null && experience.memory_count_after !== null && (
                      <p className="rounded-full bg-white/[0.05] px-3 py-1 font-mono text-xs text-muted">
                        Hindsight memories {experience.memory_count_before} to <span className="text-memory">{experience.memory_count_after}</span>
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-xl font-semibold tracking-tight">{incident.id} resolved.</p>
                    <p className="text-sm text-amber-300">{saveExperience ? "Hindsight was unavailable, so memory was not updated." : "You chose not to save this to memory."}</p>
                  </>
                )}
                <div className="tile w-full space-y-2 text-left text-xs">
                  <p className="text-ink">
                    <LinkedText text={experience.pattern} />
                  </p>
                  {experience.worked_fixes.map((f) => (
                    <p key={f} className="flex items-start gap-2 text-ink">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" /> {f}
                    </p>
                  ))}
                  {experience.failed_fixes.map((f) => (
                    <p key={f} className="flex items-start gap-2 text-ink">
                      <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-severity" aria-hidden="true" /> {f}
                    </p>
                  ))}
                  {experience.retained_text && (
                    <>
                      <button type="button" onClick={() => setShowRetained((v) => !v)} className="btn btn-ghost btn-sm -ml-2">
                        {showRetained ? "Hide" : "Show"} the exact text saved to Hindsight
                      </button>
                      {showRetained && <pre className="glass-well max-h-48 overflow-auto whitespace-pre-wrap rounded-xl p-3 font-mono text-[10px] leading-4 text-muted">{experience.retained_text}</pre>}
                    </>
                  )}
                </div>
                <p className="text-[11px] text-muted">
                  Press <Kbd>{shortcut}</Kbd> on the next error to see it recalled.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
          {error && phase !== "diagnosis" && phase !== "found" && <p className="mt-3 text-center text-xs text-severity">{error}</p>}
        </div>

        {/* footer */}
        {showComposer && (
          <div className="shrink-0 px-4 pb-4 pt-1">
            <div
              className={`glass-well flex items-end gap-2 rounded-[22px] p-1.5 pl-4 transition-shadow focus-within:border-memory/40 ${voice.listening ? "shadow-[0_0_0_1px_rgba(45,212,191,0.5),0_0_24px_rgba(45,212,191,0.18)]" : ""}`}
            >
              <textarea
                ref={composerRef}
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={Math.min(5, Math.max(1, composer.split("\n").length))}
                placeholder={phase === "answer" ? "Ask a follow-up..." : "Paste an error or ask a question"}
                className="bare-input max-h-32 min-h-[36px] flex-1 resize-none border-0 bg-transparent py-2 text-[14px] leading-5 text-ink outline-none placeholder:text-muted/60"
              />
              {voice.supported && (
                <button
                  type="button"
                  onClick={() => (voice.listening || voice.starting ? voice.stop() : voice.start())}
                  aria-label={voice.listening ? "Stop listening" : "Speak"}
                  title={voice.listening ? "Stop" : "Speak (Windows speech recognition, offline)"}
                  className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${voice.listening ? "bg-memory/20 text-memory" : "text-muted hover:bg-white/[0.08] hover:text-ink"}`}
                >
                  {voice.listening && (
                    <motion.span
                      className="absolute inset-0 rounded-full border border-memory/60"
                      animate={{ scale: [1, 1.25 + voice.level * 0.5, 1], opacity: [0.8, 0, 0.8] }}
                      transition={{ duration: 1.4, repeat: Infinity }}
                    />
                  )}
                  {voice.listening ? <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" /> : voice.starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Mic className="h-4 w-4" aria-hidden="true" />}
                </button>
              )}
              <button
                type="button"
                onClick={submit}
                disabled={!composer.trim() || (intent === "ask" && !memoryOn)}
                aria-label={intent === "investigate" ? "Investigate" : "Ask"}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-memory text-[#04201d] transition-all hover:brightness-110 active:scale-95 disabled:bg-white/10 disabled:text-muted"
              >
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {(composer.trim() || voice.error) && (
              <p className="mt-2 px-1 text-[11px] text-muted">
                {voice.error ?? (
                  <>
                    {intent === "investigate" ? "Enter investigates this as an error" : memoryOn ? "Enter asks your team's memory" : "Turn memory on to ask past incidents"}
                    {" · "}
                    <button type="button" onClick={() => setForced(intent === "investigate" ? "ask" : "investigate")} className="text-memory hover:underline">
                      {intent === "investigate" ? "ask instead" : "investigate instead"}
                    </button>
                  </>
                )}
              </p>
            )}
          </div>
        )}

        {phase === "diagnosis" && diagnosis && (
          <div className="shrink-0 border-t border-white/[0.06] px-4 pb-4 pt-3">
            {notice && <p className="mb-2 text-center text-[11px] text-success">{notice}</p>}
            {attempts.some((a) => a.outcome === "worked" || a.outcome === "partial") ? (
              <button type="button" onClick={() => void openResolve()} className="btn btn-primary btn-lg w-full">
                <Check className="h-4 w-4" aria-hidden="true" /> Resolve and save to memory
              </button>
            ) : (
              <>
                <p className="mb-2 text-center text-[12px] text-muted">After you apply a fix, how did it go?</p>
                <div className="grid grid-cols-4 gap-1.5">
                  {REPORTED.map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => {
                        setSheet(r.value);
                        setAction((a) => a || diagnosis.try_first?.action || "");
                      }}
                      className={`btn ${r.tone} btn-sm !px-2`}
                    >
                      {r.icon} {r.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {phase === "resolve" && draft && (
          <div className="flex shrink-0 gap-2 border-t border-white/[0.06] px-4 pb-4 pt-3">
            <button type="button" onClick={() => setPhase("diagnosis")} className="btn btn-secondary btn-lg">
              Back
            </button>
            <button type="submit" form="resolve-form" disabled={saving || draft.fix.trim().length < 3 || draft.root_cause.trim().length < 5} className="btn btn-primary btn-lg flex-1">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
              {saving ? "Saving to Hindsight..." : saveExperience ? "Resolve and learn" : "Resolve without saving"}
            </button>
          </div>
        )}

        {phase === "learned" && (
          <div className="flex shrink-0 gap-2 border-t border-white/[0.06] px-4 pb-4 pt-3">
            <button type="button" onClick={() => reset(activation)} className="btn btn-primary btn-lg flex-1">
              <RotateCcw className="h-4 w-4" aria-hidden="true" /> Next incident
            </button>
            {desktop && incident && (
              <button type="button" onClick={() => desktop?.openConsole(`/incidents/${incident.id}`)} className="btn btn-secondary btn-lg">
                Open in console
              </button>
            )}
          </div>
        )}

        {/* outcome sheet */}
        <AnimatePresence>
          {sheet && (
            <>
              <motion.div key="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSheet(null)} className="absolute inset-0 z-10 bg-black/45" />
              <motion.form
                key="sheet"
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", stiffness: 420, damping: 36 }}
                // Focus once the sheet has arrived; focusing while it is still off-screen scrolls the whole card.
                onAnimationComplete={() => sheetInputRef.current?.focus({ preventScroll: true })}
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveOutcome();
                }}
                className="glass-strong absolute inset-x-0 bottom-0 z-20 space-y-3 rounded-t-[26px] p-5"
              >
                <div className="mx-auto h-1 w-10 rounded-full bg-white/20" aria-hidden="true" />
                <p className="text-base font-semibold tracking-tight">
                  {sheet === "worked" ? "Nice. What did you change?" : sheet === "partial" ? "What helped, and what is still off?" : sheet === "reverted" ? "What did you roll back?" : "What did you try?"}
                </p>
                <input ref={sheetInputRef} value={action} onChange={(e) => setAction(e.target.value)} placeholder="The change you made" className="field text-xs" />
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder={sheet === "worked" ? "Optional: for example, connection errors stopped within a minute." : "Optional: what happened?"}
                  className="field resize-none text-xs leading-5"
                />
                <p className="text-[11px] text-muted">
                  {sheet === "worked" || sheet === "partial" ? "Next you can review the experience before it is saved." : "Failed attempts are remembered too, so the next engineer is warned."}
                </p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setSheet(null)} className="btn btn-secondary btn-lg">
                    Cancel
                  </button>
                  <button type="submit" disabled={action.trim().length < 3 || recording} className="btn btn-primary btn-lg flex-1">
                    {recording ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />} Save
                  </button>
                </div>
              </motion.form>
            </>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
