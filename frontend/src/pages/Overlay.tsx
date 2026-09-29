import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  Check,
  ChevronLeft,
  CircleAlert,
  CircleCheck,
  Code2,
  FolderPlus,
  ImageUp,
  Loader2,
  Mic,
  RotateCcw,
  ScanSearch,
  Square,
  Undo2,
  X,
} from "lucide-react";
import AssistAnswerView from "../components/AssistAnswerView";
import { ModeLine } from "../components/DiagnosisCard";
import { IncidentChip, LinkedText } from "../components/IncidentPeek";
import MarkdownLite from "../components/MarkdownLite";
import Orb, { ORB } from "../components/Orb";
import ResultView from "../components/ResultView";
import { Kbd, Switch } from "../components/ui";
import { api, streamDiagnosis } from "../lib/api";
import { desktop, looksLikeError, shortcutLabel, type Activation, type IdeContext, type WatchReading } from "../lib/desktop";
import { duration, relativeAge } from "../lib/format";
import { useVoice } from "../lib/voice";
import type {
  AssistAnswer,
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

type Phase = "consent" | "watching" | "home" | "working" | "diagnosis" | "resolve" | "learned";
type Intent = "investigate" | "ask";
type Finding = { kind: "screen" | "logs" | "clipboard"; title: string; label: string; text: string };
/** One question asked in the card and FRIDAY's grounded answer. */
type ChatTurn = { id: number; question: string; answer: AssistAnswer | null; error: string | null };
/** The "Read my screen" session: FRIDAY reads the screen until the engineer stops it. */
type WatchState = { starting: boolean; last: WatchReading | null; clearReads: number };
/** What the engineer reports after applying the fix. "reverted" is stored as a failed attempt with a note. */
type Reported = "worked" | "partial" | "failed" | "reverted";

const PROJECT_KEY = "oncall.overlay.project";
const CARD_MARGIN = 20; // transparent margin around the card in the desktop window, room for its soft shadow
const CLEAR_READS = 2; // consecutive reads without the error before FRIDAY treats it as gone from the screen
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

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
  const [notice, setNotice] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [forced, setForced] = useState<Intent | null>(null);
  const [memoryOn, setMemoryOn] = useState(true);
  const [incident, setIncident] = useState<IncidentCreated | null>(null);
  const [working, setWorking] = useState<{ kind: Intent; text: string } | null>(null);
  const [steps, setSteps] = useState<InvestigationStep[]>([]);
  const [matched, setMatched] = useState<MatchedIncident[]>([]);
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [watch, setWatch] = useState<WatchState | null>(null);
  const [pendingError, setPendingError] = useState<WatchReading | null>(null);
  const [errorGone, setErrorGone] = useState(false);
  const [readingImage, setReadingImage] = useState(false);  const [error, setError] = useState<string | null>(null);
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
  const fileRef = useRef<HTMLInputElement>(null);
  const watchRef = useRef(watch);
  watchRef.current = watch;
  const incidentRef = useRef<IncidentCreated | null>(null);
  // The error FRIDAY is handling; the same error scrolling in a terminal must not open a second incident.
  const handledError = useRef<string | null>(null);
  const clearRef = useRef(0);
  const candidate = useRef<{ fingerprint: string; reads: number } | null>(null);
  const chatId = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  // A new question or answer scrolls into view at the bottom of the card.
  useEffect(() => {
    if (chat.length) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [chat]);

  const voice = useVoice((text) => setComposer((c) => (c.trim() ? `${c.trim()} ${text}` : text)));
  const project = projects?.find((p) => p.id === projectId) ?? null;
  const shortcut = shortcutLabel(desktop?.shortcut ?? "Control+Space");
  const intent: Intent = forced ?? (looksLikeError(composer) ? "investigate" : "ask");
  const ide = watch?.last?.ide ?? activation?.ide ?? null;
  const ideProject = ide?.folderPath ? projects?.find((p) => samePath(p.root_path, ide.folderPath!)) ?? null : null;
  const needsFolderConsent = Boolean(desktop?.authorizeFolder && ide?.folderPath && projects !== null && !ideProject);

  // The desktop window is fully transparent and sized to the card, so the page background must stay clear.
  useEffect(() => {
    if (!desktop) return;
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
  }, []);

  // Keep the window hugging the card. offsetHeight ignores the open animation's transform, so this is the final size.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const card = cardRef.current;
    if (!desktop?.fitOverlay || !card) return;
    const report = () => desktop?.fitOverlay?.(card.offsetHeight + CARD_MARGIN * 2);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(card);
    return () => observer.disconnect();
  }, [openKey]);

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
      setPhase(watchRef.current ? "watching" : desktop?.watchStart ? "consent" : "home");
      setIncident(null);
      setWorking(null);
      setSteps([]);
      setMatched([]);
      setDiagnosis(null);
      setChat([]);
      setPendingError(null);
      setErrorGone(false);
      setError(null);
      setNotice(null);
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
      else if (!watchRef.current) dismiss();
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
    if (phase === "home") window.setTimeout(() => composerRef.current?.focus({ preventScroll: true }), 120);
  }, [phase]);

  /** Yes: allow the IDE folder if needed (native dialog), then read the screen until the engineer presses Stop. */
  async function startWatching() {
    if (!desktop?.watchStart) return;
    setNotice(null);
    setError(null);
    clearRef.current = 0;
    handledError.current = null;
    setWatch({ starting: true, last: null, clearReads: 0 });
    setPhase("watching");
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
    const started = await desktop.watchStart();
    if (!started.ok) {
      setWatch(null);
      setNotice(started.message);
      setPhase("home");
    }
  }

  function stopWatching() {
    desktop?.watchStop?.();
    setWatch(null);
    setPendingError(null);
    handledError.current = null;
    if (phaseRef.current === "watching") setPhase("home");
  }

  /** Connects the folder open in the engineer's IDE, through the same native consent dialog. */
  async function connectIdeFolder() {
    if (!ide?.folderPath || !desktop?.authorizeFolder) return;
    const allowed = await desktop.authorizeFolder(ide.folderPath);
    if ("project" in allowed) {
      storeProject(allowed.project.id);
      setProjectId(allowed.project.id);
      await loadProjects();
    } else if ("error" in allowed) {
      setNotice(allowed.error);
    }
  }

  /** Every read of the screen: a new error is investigated at once; a gone error prompts for the outcome. */
  const onReading = useRef<(reading: WatchReading) => void>(() => undefined);
  onReading.current = (reading: WatchReading) => {
    clearRef.current = reading.ok && !reading.found ? clearRef.current + 1 : reading.found ? 0 : clearRef.current;
    setWatch((w) => (w ? { starting: false, last: reading, clearReads: clearRef.current } : w));
    if (!reading.ok) return;
    const folder = reading.ide?.folderPath;
    const match = folder ? projects?.find((p) => samePath(p.root_path, folder)) : undefined;
    if (match && match.id !== projectRef.current) setProjectId(match.id);

    const current = phaseRef.current;
    const open = incidentRef.current?.status === "open";
    const busy = current === "working" || current === "resolve" || (current === "diagnosis" && open);
    if (reading.found && reading.fingerprint) {
      if (reading.fingerprint === handledError.current) {
        if (errorGone) setErrorGone(false); // it came back: the fix did not hold
        return;
      }
      // A new error must be read twice in a row before FRIDAY acts on it, so one garbled OCR frame never opens an incident.
      const seen = candidate.current;
      candidate.current = { fingerprint: reading.fingerprint, reads: seen?.fingerprint === reading.fingerprint ? seen.reads + 1 : 1 };
      if (candidate.current.reads < 2) return;
      if (busy) {
        setPendingError(reading);
        return;
      }
      handledError.current = reading.fingerprint;
      setPendingError(null);
      void investigate(reading.text, "screen");
      return;
    }
    if (clearRef.current >= CLEAR_READS) {
      setPendingError(null);
      if (current === "diagnosis" && open && handledError.current) setErrorGone(true);
      // Once the screen is clear and nothing is open, the same error appearing again is a new incident.
      if (!busy) handledError.current = null;
    }
  };

  useEffect(() => {
    if (!desktop?.onWatch) return;
    const offReading = desktop.onWatch((reading) => onReading.current(reading));
    const offEnded = desktop.onWatchEnded?.((payload) => {
      setWatch(null);
      setNotice(payload.reason);
      if (phaseRef.current === "watching") setPhase("home");
    });
    const offFocus = desktop.onFocusComposer?.(() => composerRef.current?.focus({ preventScroll: true }));
    return () => {
      offReading();
      offEnded?.();
      offFocus?.();
    };
  }, []);

  /** Screen reading unavailable: the engineer can hand FRIDAY a screenshot instead (read by the vision model). */
  async function readScreenshot(file: File) {
    if (!/^image\/(png|jpeg)$/.test(file.type) || file.size > MAX_IMAGE_BYTES) {
      setNotice("Use a PNG or JPEG screenshot under 6 MB.");
      return;
    }
    setReadingImage(true);
    setNotice(null);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    }).catch(() => "");
    const result = dataUrl ? await api.readScreen(dataUrl) : null;
    setReadingImage(false);
    if (!result) setNotice("The screenshot could not be read from disk.");
    else if (!result.ok) setNotice(result.error.message);
    else if (!result.data.found) setNotice(`No error found in the screenshot (read by ${result.data.model}).`);
    else {
      setComposer(result.data.text.trim());
      setNotice(`Read from your screenshot by ${result.data.model}. Check it, then send.`);
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
    incidentRef.current = created.data;
    setErrorGone(false);
    setChat([]);
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

  /** A question about what the engineer is looking at: screen + memory + project, answered with sources. */
  async function ask(question: string) {
    const text = question.trim();
    if (text.length < 2) return;
    voice.stop();
    setError(null);
    const id = ++chatId.current;
    setChat((c) => [...c, { id, question: text, answer: null, error: null }]);
    setComposer("");
    setForced(null);
    if (phaseRef.current === "consent") setPhase("home");
    const screen = watchRef.current?.last?.found ? watchRef.current.last.text : undefined;
    const result = await api.assist({
      question: text,
      ...(screen ? { screen_text: screen } : {}),
      ...(incidentRef.current ? { incident_id: incidentRef.current.id } : {}),
      ...(projectRef.current !== null ? { project_id: projectRef.current } : {}),
    });
    setChat((c) => c.map((turn) => (turn.id === id ? { ...turn, answer: result.ok ? result.data : null, error: result.ok ? null : result.error.message } : turn)));
  }

  function submit() {
    const text = composer.trim();
    if (!text) return;
    if (intent === "investigate") {
      setComposer("");
      void investigate(text, "manual");
    } else void ask(text);
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
      if (incidentRef.current) incidentRef.current = { ...incidentRef.current, status: "resolved" };
      setErrorGone(false);
      setPhase("learned");
    } else {
      setError(result.error.message);
    }
  }

  // ------------------------------------------------------------------ derived view state

  const recallStep = steps.find((s) => s.name === "recall");
  const unavailable = Boolean(recallStep?.detail.startsWith("Hindsight unavailable") || diagnosis?.memory_unavailable);
  const orbState = voice.listening
    ? ORB.listening
    : phase === "working" || watch?.starting
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
  const learnedHere = diagnosis?.matched.find((m) => m.learned_live && diagnosis.cited_incidents.includes(m.id));
  const wide = phase === "diagnosis" || phase === "resolve" || phase === "working" || phase === "learned" || chat.length > 0;
  const showComposer = phase === "home" || phase === "watching" || phase === "diagnosis" || phase === "learned";
  const showHeader = phase !== "consent";
  const last = watch?.last ?? null;
  const readAgo = last ? relativeAge(last.at) : null;

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
      className={desktop ? "relative flex h-screen w-screen items-center justify-center overflow-hidden p-5 select-none bg-transparent" : "fixed inset-0 flex items-center justify-center p-6 bg-[#101010]/80 backdrop-blur-md"}
      onMouseDown={(e) => {
        if (!desktop && e.target === e.currentTarget && !sheet) dismiss();
      }}
    >
      <motion.div
        key={openKey}
        ref={cardRef}
        layout
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={closing ? { opacity: 0, scale: 0.94, y: 8 } : { opacity: 1, scale: 1, y: 0 }}
        transition={closing ? { duration: 0.15, ease: [0.4, 0, 1, 1] } : { type: "spring", stiffness: 380, damping: 22, mass: 0.8 }}
        onAnimationComplete={() => {
          if (closing) desktop?.hide();
        }}
        className={`glass-strong glass-fluid relative flex w-full flex-col overflow-hidden rounded-[26px] border border-white/20 bg-bg ${
          desktop ? "max-h-[680px] shadow-[0_6px_16px_rgba(0,0,0,0.45)]" : `max-h-[86vh] shadow-[0_24px_80px_rgba(0,0,0,0.85)] ${wide ? "max-w-[500px]" : "max-w-[420px]"}`
        }`}
      >
        {watch && (
          <div className="flex shrink-0 items-center gap-3 border-b border-sky-300/15 bg-sky-400/[0.06] px-4 py-2.5">
            <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
              {!watch.starting && last?.ok && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-300/60" />}
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${last && !last.ok ? "bg-severity" : "bg-sky-300"}`} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-ink">
                {watch.starting || !last ? "Starting screen reading..." : last.ok ? "Reading your screen" : "FRIDAY couldn't read the current screen"}
              </p>
              <p className="truncate text-[11px] text-muted" title={last?.message}>
                {last && !last.ok
                  ? last.message
                  : last
                    ? `${ide ? `${ide.ide}${ide.folder ? ` · ${ide.folder}` : ""}` : last.window?.app || last.window?.process || "Your screen"} · ${
                        last.found ? "error on screen" : "no error visible"
                      } · read ${readAgo}`
                    : "Frames stay on this computer and are never saved"}
              </p>
            </div>
            {ide?.folderPath && !ideProject && desktop?.authorizeFolder && (
              <button type="button" onClick={() => void connectIdeFolder()} className="btn btn-ghost !px-2 !py-1 text-[11px]" title={`Let FRIDAY read ${ide.folderPath}`}>
                <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" /> Connect {ide.folder}
              </button>
            )}
            <button type="button" onClick={stopWatching} className="btn btn-secondary !px-2.5 !py-1 text-[11px]">
              <Square className="h-3 w-3 fill-current" aria-hidden="true" /> Stop
            </button>
          </div>
        )}
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

        <div ref={bodyRef} className="min-h-0 overflow-y-auto px-6 pb-5">
          <AnimatePresence mode="wait" initial={false}>
            {phase === "consent" && (
              <motion.div key="consent" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="flex flex-col items-center pb-1 pt-2 text-center">
                <motion.div initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 13, delay: 0.05 }}>
                  <Orb size={124} density={58} centerOpacity={12} {...orbState} />
                </motion.div>
                <h1 className="mt-2 text-xl font-semibold tracking-tight text-white">Want me to read your screen?</h1>
                <p className="mt-1.5 max-w-[350px] text-sm text-white/60">
                  I'll keep reading it until you press Stop, catch errors as they appear and check them against your team's memory. It's read on this
                  computer and never saved.
                </p>
                {ide && (
                  <div className="mt-4 w-full">
                    <IdeLine ide={ide} />
                    {needsFolderConsent && <p className="mt-1 text-[11px] text-muted">I'll also ask to read the {ide.folder} folder.</p>}
                  </div>
                )}
                <div className="mt-5 flex w-full gap-2">
                  <button type="button" onClick={() => setPhase("home")} className="btn btn-secondary btn-lg flex-1">
                    Not now
                  </button>
                  <button type="button" autoFocus onClick={() => void startWatching()} className="btn btn-primary btn-lg flex-1">
                    <ScanSearch className="h-4 w-4" aria-hidden="true" /> Read my screen
                  </button>
                </div>
              </motion.div>
            )}

            {phase === "watching" && (
              <motion.div key="watching" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="flex flex-col items-center pt-3 text-center">
                <Orb size={92} density={70} {...orbState} audio={voice.audio} />
                <p className="mt-2 text-lg font-semibold tracking-tight">
                  {watch?.starting || !last ? "Starting..." : last.ok ? "Watching for errors" : "Screen context unavailable"}
                </p>
                <p className="mt-1 max-w-[340px] text-sm text-muted">
                  {last && !last.ok
                    ? "Attach a screenshot or paste the error below, and I'll check it against your team's memory."
                    : "When an error appears on your screen I'll check it against your team's memory. Ask me anything about what you're looking at."}
                </p>
                {last && !last.ok && (
                  <button type="button" onClick={() => fileRef.current?.click()} disabled={readingImage} className="btn btn-secondary btn-sm mt-3">
                    <ImageUp className="h-3.5 w-3.5" aria-hidden="true" /> Attach screenshot
                  </button>
                )}
                {notice && <p className="mt-3 text-xs text-amber-300">{notice}</p>}
              </motion.div>
            )}

            {phase === "home" && (
              <motion.div key="home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="flex flex-col items-center pt-1 text-center">
                <Orb size={voice.listening ? 120 : 96} density={70} {...orbState} audio={voice.audio} />
                <h1 className="mt-2 text-xl font-semibold tracking-tight">{voice.listening ? "Listening..." : voice.starting ? "Starting the microphone..." : "What are you looking at?"}</h1>
                <p className="mt-1 max-w-[330px] text-sm text-muted">
                  {voice.partial ? <span className="text-ink">{voice.partial}</span> : "Paste the error, attach a screenshot, or ask what your team learned before."}
                </p>
                {notice && <p className="mt-3 text-xs text-amber-300">{notice}</p>}
                {desktop?.watchStart && (
                  <button type="button" onClick={() => void startWatching()} className="btn btn-secondary btn-sm mt-3">
                    <ScanSearch className="h-3.5 w-3.5" aria-hidden="true" /> Read my screen
                  </button>
                )}
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
                    {pendingError && (
                      <div className="flex items-center gap-2 rounded-2xl border border-severity/25 bg-severity/[0.07] px-3 py-2 text-left">
                        <CircleAlert className="h-4 w-4 shrink-0 text-severity" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12px] text-ink">A different error appeared on your screen</span>
                          <span className="block truncate font-mono text-[11px] text-severity">{errorLine(pendingError.text)}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            handledError.current = pendingError.fingerprint;
                            setPendingError(null);
                            void investigate(pendingError.text, "screen");
                          }}
                          className="btn btn-secondary !px-2 !py-1 text-[11px]"
                        >
                          Investigate
                        </button>
                      </div>
                    )}
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
                    <p className="eyebrow !text-success">Saved to Hindsight</p>
                    <p className="text-xl font-semibold tracking-tight">FRIDAY learned.</p>
                    <p className="text-sm text-muted">Your resolution is now available for future incidents.</p>
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
                  {watch ? "I'm still reading your screen; the next error will be checked against this." : <>Press <Kbd>{shortcut}</Kbd> on the next error to see it recalled.</>}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
          {chat.length > 0 && showComposer && (
            <div className="mt-4 space-y-4 border-t border-white/[0.06] pt-4">
              {chat.map((turn) => (
                <motion.div key={turn.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-2">
                  <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.08] px-3 py-1.5 text-[13px] text-ink">{turn.question}</p>
                  {turn.error ? (
                    <p className="text-xs text-severity">{turn.error}</p>
                  ) : turn.answer ? (
                    <AssistAnswerView answer={turn.answer} compact />
                  ) : (
                    <p className="flex items-center gap-2 text-xs text-muted">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      {watch?.last?.found ? "Reading your screen, searching memory and your project..." : "Searching memory and your project..."}
                    </p>
                  )}
                </motion.div>
              ))}
            </div>
          )}
          {error && phase !== "diagnosis" && <p className="mt-3 text-center text-xs text-severity">{error}</p>}
        </div>

        {/* footer */}
        {showComposer && (
          <div className="shrink-0 px-4 pb-4 pt-1">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void readScreenshot(file);
              }}
            />
            <div
              className={`glass-well flex items-end gap-2 rounded-[22px] p-1.5 pl-2 transition-shadow focus-within:border-memory/40 ${voice.listening ? "shadow-[0_0_0_1px_rgba(255,255,255,0.45),0_0_24px_rgba(255,255,255,0.12)]" : ""}`}
            >
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={readingImage}
                aria-label="Read an error from a screenshot"
                title="Read an error from a screenshot (PNG or JPEG)"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/[0.08] hover:text-ink disabled:opacity-40"
              >
                {readingImage ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ImageUp className="h-4 w-4" aria-hidden="true" />}
              </button>
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
                placeholder={watch ? "Ask about what's on your screen..." : incident ? "Ask about this incident..." : "Paste an error or ask a question"}
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
                disabled={!composer.trim()}
                aria-label={intent === "investigate" ? "Investigate" : "Ask"}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-memory text-black transition-all hover:brightness-110 active:scale-95 disabled:bg-white/10 disabled:text-muted"
              >
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {(composer.trim() || voice.error) && (
              <p className="mt-2 px-1 text-[11px] text-muted">
                {voice.error ?? (
                  <>
                    {intent === "investigate" ? "Enter investigates this as an error" : watch?.last?.found ? "Enter asks FRIDAY, with your screen as context" : "Enter asks FRIDAY"}
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
                <p className={`mb-2 text-center text-[12px] ${errorGone ? "font-medium text-success" : "text-muted"}`}>
                  {errorGone ? "The error is no longer on your screen. Did this fix work?" : "Did this fix work?"}
                </p>
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
              <RotateCcw className="h-4 w-4" aria-hidden="true" /> {watch ? "Keep watching" : "Next incident"}
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
