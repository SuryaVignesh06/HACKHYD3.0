// FRIDAY console: the orb, one incident workspace (stages, team memory, your code, likely root cause, what to do
// next) and a single composer. The investigation streams in live; every card fills from real step events.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Brain, ClipboardList, ExternalLink, GitCompareArrows, ListTree, MessageSquareText, Plus, TrendingUp, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import ActionLog from "../components/ActionLog";
import AssistAnswerView from "../components/AssistAnswerView";
import Composer, { type ComposerHandle } from "../components/Composer";
import { FridayHero, IdleWorkspace, SignalFeed, demoChoices, type DemoChoice } from "../components/ConsoleHome";
import DiagnosisCard from "../components/DiagnosisCard";
import InvestigationTimeline from "../components/InvestigationTimeline";
import LearningCurve from "../components/LearningCurve";
import MemoryPanel from "../components/MemoryPanel";
import { ORB } from "../components/Orb";
import ResolveDrawer, { ExperienceCard } from "../components/ResolveDrawer";
import ResultView from "../components/ResultView";
import Sheet from "../components/Sheet";
import Toast from "../components/Toast";
import { FOCUS_COMPOSER_EVENT } from "../components/TopBar";
import WaveBackdrop from "../components/WaveBackdrop";
import {
  CodeCard,
  IncidentHeader,
  NextStepsCard,
  RootCauseCard,
  StageRail,
  TeamMemoryCard,
  type MenuItem,
  type WorkspaceRun,
} from "../components/Workspace";
import { api, streamDiagnosis } from "../lib/api";
import { looksLikeError } from "../lib/desktop";
import { useVoice } from "../lib/voice";
import type {
  AssistAnswer,
  AttemptLogged,
  CodeFinding,
  Diagnosis,
  DemoSignal,
  EvidenceStepData,
  ExperienceCaptured,
  IncidentCreated,
  LearningPoint,
  MatchedIncident,
  Outcome,
  ProjectOut,
  RecallStepData,
  RecalledMemory,
  StreamEvent,
} from "../lib/types";

interface RunState extends WorkspaceRun {
  matched: MatchedIncident[];
  recalled: RecalledMemory[];
}

type RunKey = "on" | "off";
type SheetKind = "evidence" | "log" | "timeline" | null;
const keyOf = (memory: boolean): RunKey => (memory ? "on" : "off");

function isRecallData(data: Record<string, unknown>): data is Record<string, unknown> & RecallStepData {
  return Array.isArray(data.matched) && Array.isArray(data.recalled);
}

function isEvidenceData(data: Record<string, unknown>): data is Record<string, unknown> & EvidenceStepData {
  return Array.isArray(data.worked_fixes) && Array.isArray(data.failed_fixes);
}

function findingsOf(data: Record<string, unknown>): CodeFinding[] | null {
  return Array.isArray(data.findings) ? (data.findings as CodeFinding[]) : null;
}

/** Memory impact, computed only from the two real answers for the same incident. */
function ImpactRow({ off, on }: { off: Diagnosis; on: Diagnosis }) {
  const rows: [string, string, string][] = [
    ["Past incidents cited", String(off.cited_incidents.length), String(on.cited_incidents.length)],
    ["Verified failed-fix warnings", "0", String(on.avoid.filter((a) => a.evidence.length > 0).length)],
    ["Try first backed by past outcomes", "no", on.try_first && on.try_first.evidence.length > 0 ? `yes, ${on.try_first.evidence.length} incidents` : "no"],
    ["Confidence", off.confidence === null ? "n/a" : `${Math.round(off.confidence * 100)}%`, on.confidence === null ? "n/a" : `${Math.round(on.confidence * 100)}%`],
  ];
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-muted">
          <th className="pb-2 font-medium">Computed from the two answers</th>
          <th className="pb-2 font-medium">Without memory</th>
          <th className="pb-2 font-medium text-ink">With memory</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, a, b]) => (
          <tr key={label} className="border-t border-white/[0.06]">
            <td className="py-2 text-muted">{label}</td>
            <td className="py-2 font-mono text-muted">{a}</td>
            <td className="py-2 font-mono text-ink">{b}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AnswerPanel({ answer, onClose }: { answer: AssistAnswer; onClose: () => void }) {
  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="panel p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[15px] font-medium text-ink">
            <MessageSquareText className="h-4 w-4" aria-hidden="true" />
            {answer.memory_unavailable ? "FRIDAY memory is unavailable" : answer.no_match ? "FRIDAY" : "FRIDAY found related experience"}
          </h2>
          <p className="mt-0.5 truncate text-xs text-muted">{answer.question}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Dismiss answer" className="btn btn-ghost !p-1.5">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-3">
        <AssistAnswerView answer={answer} />
      </div>
    </motion.section>
  );
}

export default function Console({ memoryOn, refreshStats, project, onConnectProject }: {
  memoryOn: boolean;
  refreshStats: () => void;
  project: ProjectOut | null;
  onConnectProject: (() => void) | null;
}) {
  const navigate = useNavigate();
  const [demos, setDemos] = useState<DemoChoice[]>([]);
  const [composer, setComposer] = useState("");
  const [incident, setIncident] = useState<IncidentCreated | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [runs, setRuns] = useState<Partial<Record<RunKey, RunState>>>({});
  const [attempts, setAttempts] = useState<AttemptLogged[]>([]);
  const [recorded, setRecorded] = useState<Record<string, Outcome>>({});
  const [learning, setLearning] = useState<LearningPoint[]>([]);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [experience, setExperience] = useState<ExperienceCaptured | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [answer, setAnswer] = useState<AssistAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [sim, setSim] = useState<{ demo: DemoChoice; signals: DemoSignal[] } | null>(null);
  const aborts = useRef<AbortController[]>([]);
  const simTimers = useRef<number[]>([]);
  const composerRef = useRef<ComposerHandle>(null);
  const clearToast = useCallback(() => setToast(null), []);
  const closeSheet = useCallback(() => setSheet(null), []);

  const voice = useVoice((text) => setComposer((c) => (c.trim() ? `${c.trim()} ${text}` : text)));

  const refreshLearning = useCallback(() => {
    void api.learning().then((r) => r.ok && setLearning(r.data));
  }, []);

  useEffect(() => {
    void api.demoAlerts().then((r) => r.ok && setDemos(demoChoices(r.data)));
    refreshLearning();
    const timers = simTimers.current;
    return () => {
      aborts.current.forEach((a) => a.abort());
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [refreshLearning]);

  useEffect(() => {
    const focus = () => composerRef.current?.focus();
    // "/" jumps to the composer, as in most consoles, unless the engineer is already typing somewhere.
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        focus();
      }
    };
    window.addEventListener(FOCUS_COMPOSER_EVENT, focus);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(FOCUS_COMPOSER_EVENT, focus);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const running = Boolean(runs.on?.running || runs.off?.running);

  const run = useCallback(
    async (incidentId: string, memory: boolean) => {
      const key = keyOf(memory);
      const controller = new AbortController();
      aborts.current.push(controller);
      const update = (fn: (r: RunState) => RunState) =>
        setRuns((prev) => {
          const current = prev[key];
          return current ? { ...prev, [key]: fn(current) } : prev;
        });
      setRuns((prev) => ({
        ...prev,
        [key]: {
          memory, steps: [], matched: [], recalled: [], matchedCount: 0, findings: [], diagnosis: null, error: null,
          running: true, startedAt: Date.now(), fix: null, unavailable: false,
        },
      }));
      await streamDiagnosis(
        incidentId,
        memory,
        (event: StreamEvent) => {
          if (event.type === "step") {
            const data = event.data;
            const findings = event.step.name === "inspect" ? findingsOf(data) : null;
            update((r) => ({
              ...r,
              steps: [...r.steps, event.step],
              ...(event.step.name === "recall" && isRecallData(data)
                ? { matched: data.matched, recalled: data.recalled, matchedCount: data.matched.length, unavailable: data.unavailable === true }
                : {}),
              ...(event.step.name === "evidence" && isEvidenceData(data) ? { fix: { worked: data.worked_fixes, failed: data.failed_fixes } } : {}),
              ...(findings ? { findings } : {}),
            }));
          } else if (event.type === "diagnosis") {
            update((r) => ({ ...r, diagnosis: event.diagnosis, findings: event.diagnosis.findings, running: false }));
          } else {
            update((r) => ({ ...r, error: event.message, running: false }));
          }
        },
        controller.signal,
      );
      refreshLearning();
      refreshStats();
    },
    [refreshLearning, refreshStats],
  );

  // Toggling memory after a diagnosis runs the other mode on the same incident, for the side-by-side view.
  useEffect(() => {
    if (!incident || running || incident.status === "resolved") return;
    if (!runs[keyOf(memoryOn)] && (runs.on || runs.off)) void run(incident.id, memoryOn);
  }, [memoryOn]); // only the toggle should trigger a comparison run

  function reset() {
    aborts.current.forEach((a) => a.abort());
    aborts.current = [];
    setIncident(null);
    setRuns({});
    setAttempts([]);
    setRecorded({});
    setExperience(null);
    setLogError(null);
    setCreateError(null);
    setSheet(null);
  }

  function stopSimulation() {
    simTimers.current.forEach((t) => window.clearTimeout(t));
    simTimers.current = [];
    setSim(null);
  }

  async function investigate(alertText: string, meta?: { service: string; severity: string }) {
    setCreateError(null);
    setAnswer(null);
    setCreating(true);
    const created = await api.createIncident({
      alert_text: alertText,
      ...(meta ? { service: meta.service, severity: meta.severity } : {}),
      origin: meta ? "demo" : "manual",
      ...(project ? { project_id: project.id } : {}),
    });
    setCreating(false);
    if (!created.ok) {
      setCreateError(created.error.message);
      return;
    }
    reset();
    setIncident(created.data);
    setComposer("");
    void run(created.data.id, memoryOn);
  }

  async function ask(question: string) {
    setAsking(true);
    setAskError(null);
    const result = await api.assist({
      question,
      ...(incident ? { incident_id: incident.id } : {}),
      ...(project ? { project_id: project.id } : {}),
    });
    setAsking(false);
    if (result.ok) {
      setAnswer(result.data);
      setComposer("");
    } else {
      setAskError(result.error.message);
    }
  }

  function submitComposer(text: string) {
    voice.stop();
    if (looksLikeError(text)) void investigate(text);
    else void ask(text);
  }

  function simulate(demo: DemoChoice) {
    stopSimulation();
    reset();
    setAnswer(null);
    setSim({ demo, signals: [] });
    demo.signals.forEach((signal) => {
      simTimers.current.push(
        window.setTimeout(() => setSim((s) => (s && s.demo.key === demo.key ? { ...s, signals: [...s.signals, signal] } : s)), signal.at_ms),
      );
    });
    const last = Math.max(0, ...demo.signals.map((s) => s.at_ms)) + 700;
    simTimers.current.push(
      window.setTimeout(() => {
        setSim(null);
        void investigate(demo.alertText, { service: demo.service, severity: demo.severity });
      }, last),
    );
  }

  async function logAttempt(action: string, outcome: Outcome, notes = ""): Promise<boolean> {
    if (!incident) return false;
    setLogError(null);
    const result = await api.logAttempt(incident.id, { action, outcome, ...(notes ? { notes } : {}) });
    if (!result.ok) {
      setLogError(result.error.message);
      setToast(null);
      return false;
    }
    setAttempts((a) => [...a, result.data]);
    setRecorded((r) => ({ ...r, [action]: outcome }));
    setToast(result.data.memory_retained ? "Fix attempt saved to Hindsight memory." : "Fix attempt recorded. Hindsight did not confirm the save.");
    return true;
  }

  function onResolved(captured: ExperienceCaptured) {
    setExperience(captured);
    setIncident((i) => (i ? { ...i, status: "resolved" } : i));
    setResolveOpen(false);
    setToast(captured.memory_retained ? "Saved to memory. The next similar incident will know this." : "Resolved. Hindsight did not confirm the save.");
    refreshStats();
  }

  const primary = runs[keyOf(memoryOn)] ?? runs.on ?? runs.off;
  const other = primary ? runs[keyOf(!primary.memory)] : undefined;
  const bothDone = Boolean(runs.on?.diagnosis && runs.off?.diagnosis);
  const open = incident?.status === "open";
  const resolved = incident?.status === "resolved";
  const fixAction = primary?.diagnosis?.try_first?.action ?? null;
  const busy = creating || asking || sim !== null;

  const orb = voice.listening
    ? ORB.listening
    : running || creating || asking || sim
      ? ORB.thinking
      : experience?.memory_retained
        ? ORB.success
        : primary?.error || primary?.unavailable
          ? ORB.warning
          : !memoryOn
            ? ORB.off
            : ORB.idle;

  const menu: MenuItem[] = incident
    ? [
        {
          label: other ? (other.running ? "Comparison running..." : "Comparison below") : `Compare with memory ${primary?.memory ? "off" : "on"}`,
          icon: <GitCompareArrows className="h-4 w-4" aria-hidden="true" />,
          onSelect: () => primary && void run(incident.id, !primary.memory),
          disabled: !primary || running || Boolean(other) || resolved,
        },
        { label: "Why FRIDAY thinks this", icon: <Brain className="h-4 w-4" aria-hidden="true" />, onSelect: () => setSheet("evidence"), disabled: !primary },
        { label: "Log a fix attempt", icon: <ClipboardList className="h-4 w-4" aria-hidden="true" />, onSelect: () => setSheet("log"), disabled: !open },
        { label: "Investigation log", icon: <ListTree className="h-4 w-4" aria-hidden="true" />, onSelect: () => setSheet("timeline"), disabled: !primary },
        { label: "Open incident page", icon: <ExternalLink className="h-4 w-4" aria-hidden="true" />, onSelect: () => navigate(`/incidents/${incident.id}`) },
        { label: "New incident", icon: <Plus className="h-4 w-4" aria-hidden="true" />, onSelect: () => { stopSimulation(); reset(); composerRef.current?.focus(); } },
      ]
    : [];

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <WaveBackdrop />
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1260px] space-y-5 px-6 pb-8 pt-2">
          <FridayHero orb={orb} audio={voice.audio} compact={Boolean(incident || sim)} />

          <AnimatePresence>{answer && <AnswerPanel key={answer.question} answer={answer} onClose={() => setAnswer(null)} />}</AnimatePresence>
          {(createError || askError) && <p className="panel px-5 py-3 text-sm text-severity">{createError ?? askError}</p>}
          {sim && <SignalFeed demo={sim.demo} signals={sim.signals} />}

          {incident && primary ? (
            <>
              <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="panel p-5">
                <IncidentHeader incident={incident} steps={primary.steps} menu={menu} />
                <div className="mt-6">
                  <StageRail run={primary} resolved={Boolean(resolved)} retained={experience ? experience.memory_retained : null} />
                </div>
                <div className="mt-5 grid gap-3 lg:grid-cols-3">
                  <TeamMemoryCard run={primary} onOpen={() => setSheet("evidence")} />
                  <CodeCard run={primary} projectName={project?.name ?? primary.diagnosis?.project ?? null} onConnect={onConnectProject} />
                  <RootCauseCard run={primary} onOpen={() => setSheet("evidence")} onRetry={() => void run(incident.id, primary.memory)} />
                </div>
              </motion.section>

              <NextStepsCard
                run={primary}
                incident={incident}
                recorded={fixAction ? recorded[fixAction] ?? null : null}
                resolved={Boolean(resolved)}
                onOutcome={(action, outcome) => void logAttempt(action, outcome)}
                onResolve={() => setResolveOpen(true)}
                onDetails={() => setSheet("evidence")}
                onLogAttempt={() => setSheet("log")}
              />
              {logError && <p className="px-2 text-xs text-severity">{logError}</p>}

              {other && (
                <section className="panel space-y-4 p-5">
                  <h2 className="flex items-center gap-2 text-[15px] font-medium text-ink">
                    <GitCompareArrows className="h-4 w-4" aria-hidden="true" /> Same incident, with and without memory
                  </h2>
                  {bothDone && runs.off?.diagnosis && runs.on?.diagnosis ? (
                    <>
                      <div className="grid gap-3 xl:grid-cols-2">
                        <DiagnosisCard diagnosis={runs.off.diagnosis} compact />
                        <DiagnosisCard diagnosis={runs.on.diagnosis} compact />
                      </div>
                      <ImpactRow off={runs.off.diagnosis} on={runs.on.diagnosis} />
                    </>
                  ) : other.error ? (
                    <p className="text-sm text-severity">{other.error}</p>
                  ) : (
                    <p className="text-sm text-muted">Running the {other.memory ? "memory" : "no-memory"} answer for comparison...</p>
                  )}
                </section>
              )}

              {experience && <ExperienceCard experience={experience} />}
            </>
          ) : (
            !sim && <IdleWorkspace demos={demos} busy={busy} onDiagnose={(d) => void investigate(d.alertText, { service: d.service, severity: d.severity })} onSimulate={simulate} />
          )}

          <section className="panel px-5 py-4">
            <div className="flex items-center gap-2 pb-1 text-xs text-muted lg:hidden">
              <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" /> Learning curve
            </div>
            <LearningCurve points={learning} />
          </section>
        </div>
      </div>

      <div className="relative shrink-0 px-6 pb-5 pt-2">
        <Composer ref={composerRef} value={composer} onChange={setComposer} onSubmit={submitComposer} busy={busy} voice={voice} />
      </div>

      <Sheet open={sheet === "evidence"} title="Why FRIDAY thinks this" onClose={closeSheet} width="max-w-2xl">
        {primary && (
          <div className="space-y-6">
            {primary.diagnosis && !primary.diagnosis.degraded && <ResultView diagnosis={primary.diagnosis} />}
            {primary.diagnosis?.degraded && <p className="text-sm leading-6 text-ink">{primary.diagnosis.summary}</p>}
            <div className="space-y-3">
              <h3 className="eyebrow">What Hindsight recalled</h3>
              <MemoryPanel
                state={!primary.memory ? "off" : primary.unavailable ? "unavailable" : primary.steps.some((s) => s.name === "recall") ? "ready" : "searching"}
                matched={primary.matched}
                recalled={primary.recalled}
                cited={primary.diagnosis?.cited_incidents ?? []}
              />
            </div>
          </div>
        )}
      </Sheet>
      <Sheet open={sheet === "log"} title="Fix attempts" onClose={closeSheet}>
        <p className="mb-4 text-sm text-muted">Record everything you try, including what failed. Each attempt is saved to Hindsight so the next engineer is warned.</p>
        <ActionLog attempts={attempts} onLog={logAttempt} disabled={!open} />
        {logError && <p className="mt-2 text-xs text-severity">{logError}</p>}
      </Sheet>
      <Sheet open={sheet === "timeline"} title="Investigation log" onClose={closeSheet}>
        {primary && (
          <InvestigationTimeline memory={primary.memory} steps={primary.steps} running={primary.running} startedAt={primary.startedAt} matchedCount={primary.matchedCount} />
        )}
      </Sheet>

      {incident && <ResolveDrawer key={incident.id} incident={incident} open={resolveOpen} onClose={() => setResolveOpen(false)} onResolved={onResolved} />}
      <Toast message={toast} onDone={clearToast} />
    </div>
  );
}
