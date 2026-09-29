import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, BrainCircuit, CheckCheck, ClipboardList, ListTree, RotateCcw, Siren } from "lucide-react";
import ActionLog from "../components/ActionLog";
import AlertInput, { demoChoices, type AlertDraft, type DemoChoice } from "../components/AlertInput";
import { ConsoleHero, MemorySnapshot } from "../components/ConsoleHome";
import DiagnosisCard, { ModeLine } from "../components/DiagnosisCard";
import ResultView from "../components/ResultView";
import { FixHistory, Lifecycle } from "../components/DiagnosisSections";
import { IncidentChip } from "../components/IncidentPeek";
import InvestigationTimeline from "../components/InvestigationTimeline";
import LearningCurve from "../components/LearningCurve";
import MemoryPanel from "../components/MemoryPanel";
import ResolveDrawer, { ExperienceCard } from "../components/ResolveDrawer";
import Toast from "../components/Toast";
import { ConfidenceBar, Panel, SeverityBadge } from "../components/ui";
import { LinkedText } from "../components/IncidentPeek";
import { api, streamDiagnosis } from "../lib/api";
import type {
  AttemptLogged,
  Diagnosis,
  EvidenceStepData,
  ExperienceCaptured,
  FixRecord,
  IncidentCreated,
  InvestigationStep,
  LearningPoint,
  MatchedIncident,
  MemoryOverview,
  Outcome,
  RecallStepData,
  RecalledMemory,
  StreamEvent,
} from "../lib/types";

interface RunState {
  memory: boolean;
  steps: InvestigationStep[];
  matched: MatchedIncident[];
  recalled: RecalledMemory[];
  diagnosis: Diagnosis | null;
  error: string | null;
  running: boolean;
  startedAt: number;
  fix: { worked: FixRecord[]; failed: FixRecord[] } | null;
  unavailable: boolean;
}

type RunKey = "on" | "off";
const keyOf = (memory: boolean): RunKey => (memory ? "on" : "off");

function isRecallData(data: Record<string, unknown>): data is Record<string, unknown> & RecallStepData {
  return Array.isArray(data.matched) && Array.isArray(data.recalled);
}

function isEvidenceData(data: Record<string, unknown>): data is Record<string, unknown> & EvidenceStepData {
  return Array.isArray(data.worked_fixes) && Array.isArray(data.failed_fixes);
}

function ImpactRow({ off, on }: { off: Diagnosis; on: Diagnosis }) {
  const rows: [string, string, string][] = [
    ["Past incidents cited", String(off.cited_incidents.length), String(on.cited_incidents.length)],
    ["Verified failed-fix warnings", "0", String(on.avoid.filter((a) => a.evidence.length > 0).length)],
    ["Try first backed by past outcomes", "no", on.try_first && on.try_first.evidence.length > 0 ? `yes, ${on.try_first.evidence.length} incidents` : "no"],
    ["Confidence", off.confidence === null ? "n/a" : `${Math.round(off.confidence * 100)}%`, on.confidence === null ? "n/a" : `${Math.round(on.confidence * 100)}%`],
  ];
  return (
    <div className="tile !p-0">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted">
            <th className="px-4 pb-2 pt-3 font-medium">Memory impact, computed from the two answers</th>
            <th className="px-4 pb-2 pt-3 font-medium">Without</th>
            <th className="px-4 pb-2 pt-3 font-medium text-memory">With</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, a, b]) => (
            <tr key={label} className="border-t border-white/[0.06]">
              <td className="px-4 py-2 text-muted">{label}</td>
              <td className="px-4 py-2 font-mono text-muted">{a}</td>
              <td className="px-4 py-2 font-mono text-ink">{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Short answer on top, details in tabs, one question at the bottom. */
function ConsoleDiagnosis({ diagnosis, recorded, onOutcome }: {
  diagnosis: Diagnosis;
  recorded: Outcome | null;
  onOutcome?: (action: string, outcome: Outcome) => void;
}) {
  if (diagnosis.degraded) return <DiagnosisCard diagnosis={diagnosis} />;
  const learned = diagnosis.matched.some((m) => m.learned_live && diagnosis.cited_incidents.includes(m.id));
  const headline = !diagnosis.memory_enabled
    ? diagnosis.memory_unavailable
      ? "Memory unavailable"
      : "Answer without memory"
    : learned
      ? "I remember this one."
      : diagnosis.strong_match
        ? "I've seen this before."
        : "Nothing quite like this yet.";
  const tone = !diagnosis.memory_enabled ? (diagnosis.memory_unavailable ? "text-amber-300" : "text-muted") : diagnosis.strong_match ? "text-memory" : "text-amber-300";
  const fix = diagnosis.try_first;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className={`text-xl font-semibold tracking-tight ${tone}`}>{headline}</p>
        <p className="text-sm leading-6 text-ink">
          <LinkedText text={diagnosis.summary} />
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <ModeLine diagnosis={diagnosis} />
          <span className="flex items-center gap-2 text-xs text-muted">
            Confidence <ConfidenceBar value={diagnosis.confidence} tone={diagnosis.memory_enabled ? "memory" : "muted"} />
          </span>
        </div>
      </div>
      <ResultView diagnosis={diagnosis} />
      {onOutcome && fix && (
        <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-4">
          {recorded ? (
            <span className={`text-xs ${recorded === "worked" ? "text-success" : recorded === "partial" ? "text-amber-300" : "text-severity"}`}>
              Recorded: the first fix {recorded === "worked" ? "worked" : recorded === "partial" ? "partly worked" : "did not work"}. It was sent to memory.
            </span>
          ) : (
            <>
              <span className="mr-1 text-xs text-muted">Did the first fix work?</span>
              <button type="button" onClick={() => onOutcome(fix.action, "worked")} className="btn btn-success btn-sm">
                Worked
              </button>
              <button type="button" onClick={() => onOutcome(fix.action, "partial")} className="btn btn-amber btn-sm">
                Partly
              </button>
              <button type="button" onClick={() => onOutcome(fix.action, "failed")} className="btn btn-danger btn-sm">
                Didn't work
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function Console({ memoryOn, refreshStats, projectId }: { memoryOn: boolean; refreshStats: () => void; projectId: number | null }) {
  const [demos, setDemos] = useState<DemoChoice[]>([]);
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [simulateRequest, setSimulateRequest] = useState<{ choice: DemoChoice; nonce: number } | null>(null);
  const [draft, setDraft] = useState<AlertDraft>({ alertText: "", service: "payments-api", severity: "SEV1" });
  const [incident, setIncident] = useState<IncidentCreated | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Partial<Record<RunKey, RunState>>>({});
  const [attempts, setAttempts] = useState<AttemptLogged[]>([]);
  const [recorded, setRecorded] = useState<Record<string, Outcome>>({});
  const [learning, setLearning] = useState<LearningPoint[]>([]);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [experience, setExperience] = useState<ExperienceCaptured | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const aborts = useRef<AbortController[]>([]);
  const clearToast = useCallback(() => setToast(null), []);

  const refreshLearning = useCallback(() => {
    void api.learning().then((r) => r.ok && setLearning(r.data));
  }, []);

  useEffect(() => {
    void api.demoAlerts().then((r) => r.ok && setDemos(demoChoices(r.data)));
    void api.memoryOverview().then((r) => r.ok && setOverview(r.data));
    refreshLearning();
    return () => aborts.current.forEach((a) => a.abort());
  }, [refreshLearning]);

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
        [key]: { memory, steps: [], matched: [], recalled: [], diagnosis: null, error: null, running: true, startedAt: Date.now(), fix: null, unavailable: false },
      }));
      await streamDiagnosis(
        incidentId,
        memory,
        (event: StreamEvent) => {
          if (event.type === "step") {
            const data = event.data;
            update((r) => ({
              ...r,
              steps: [...r.steps, event.step],
              ...(event.step.name === "recall" && isRecallData(data) ? { matched: data.matched, recalled: data.recalled, unavailable: data.unavailable === true } : {}),
              ...(event.step.name === "evidence" && isEvidenceData(data) ? { fix: { worked: data.worked_fixes, failed: data.failed_fixes } } : {}),
            }));
          } else if (event.type === "diagnosis") {
            update((r) => ({ ...r, diagnosis: event.diagnosis, running: false }));
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

  async function submit(next: AlertDraft) {
    setCreateError(null);
    const same =
      incident && incident.status === "open" && incident.alert_text === next.alertText && incident.service === next.service;
    if (same) {
      void run(incident.id, memoryOn);
      return;
    }
    const created = await api.createIncident({
      alert_text: next.alertText,
      service: next.service,
      severity: next.severity,
      origin: "manual",
      ...(projectId !== null ? { project_id: projectId } : {}),
    });
    if (!created.ok) {
      setCreateError(created.error.message);
      return;
    }
    aborts.current.forEach((a) => a.abort());
    aborts.current = [];
    setIncident(created.data);
    setRuns({});
    setAttempts([]);
    setRecorded({});
    setExperience(null);
    setLogError(null);
    void run(created.data.id, memoryOn);
  }

  function newIncident() {
    aborts.current.forEach((a) => a.abort());
    aborts.current = [];
    setIncident(null);
    setRuns({});
    setAttempts([]);
    setRecorded({});
    setExperience(null);
    setDraft({ alertText: "", service: draft.service, severity: draft.severity });
  }

  async function logAttempt(action: string, outcome: Outcome, notes = ""): Promise<boolean> {
    if (!incident) return false;
    setLogError(null);
    const result = await api.logAttempt(incident.id, { action, outcome, ...(notes ? { notes } : {}) });
    if (!result.ok) {
      setLogError(result.error.message);
      return false;
    }
    setAttempts((a) => [...a, result.data]);
    setRecorded((r) => ({ ...r, [action]: outcome }));
    return true;
  }

  function onResolved(captured: ExperienceCaptured) {
    setExperience(captured);
    setIncident((i) => (i ? { ...i, status: "resolved" } : i));
    setToast("Saved to memory. The next similar incident will know this.");
    void api.memoryOverview().then((r) => r.ok && setOverview(r.data));
    refreshStats();
  }

  const onRun = runs.on;
  const primary = runs[keyOf(memoryOn)] ?? onRun ?? runs.off;
  const bothDone = Boolean(runs.on?.diagnosis && runs.off?.diagnosis);
  const timelineRun = onRun ?? primary;
  const recallDone = Boolean(onRun?.steps.some((s) => s.name === "recall"));
  const memoryState = onRun ? (onRun.unavailable ? "unavailable" : recallDone ? "ready" : "searching") : memoryOn ? "idle" : "off";
  const open = incident?.status === "open";

  return (
    <div className="flex h-full flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[330px_minmax(0,1fr)_360px] lg:overflow-hidden">
        <Panel title="Incident" icon={<Siren className="h-4 w-4 text-severity" aria-hidden="true" />}>
          <AlertInput
            draft={draft}
            onDraftChange={setDraft}
            demos={demos}
            busy={running}
            onSubmit={(d) => void submit(d)}
            onNewIncident={newIncident}
            hasIncident={incident !== null}
            simulateRequest={simulateRequest}
          />
          {createError && <p className="mt-3 text-xs text-severity">{createError}</p>}
        </Panel>

        <div className="flex min-h-0 flex-col gap-4 lg:overflow-y-auto lg:pr-1">
          {!incident ? (
            <ConsoleHero
              overview={overview}
              demos={demos}
              memoryOn={memoryOn}
              onDiagnose={(demo) => {
                const next = { alertText: demo.alertText, service: demo.service, severity: demo.severity };
                setDraft(next);
                void submit(next);
              }}
              onSimulate={(demo) => setSimulateRequest({ choice: demo, nonce: Date.now() })}
            />
          ) : (
            <>
              <div className="glass flex flex-wrap items-center gap-2.5 px-5 py-3.5">
                <IncidentChip id={incident.id} tone={open ? "severity" : "success"} />
                <SeverityBadge severity={incident.severity} />
                <span className="font-mono text-xs text-muted">{incident.service}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{incident.title}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${open ? "bg-severity/10 text-severity" : "bg-success/10 text-success"}`}>
                  {incident.status}
                </span>
              </div>

              {timelineRun && (
                <Lifecycle
                  memoryOn={timelineRun.memory}
                  steps={timelineRun.steps}
                  running={timelineRun.running}
                  diagnosis={timelineRun.diagnosis}
                  retained={experience ? experience.memory_retained : null}
                  matchedCount={timelineRun.matched.length}
                />
              )}

              <Panel title="Diagnosis" icon={<Activity className="h-4 w-4 text-memory" aria-hidden="true" />} className="shrink-0">
                {primary?.error ? (
                  <div className="space-y-3">
                    <p className="text-sm text-severity">{primary.error}</p>
                    <button type="button" onClick={() => void run(incident.id, primary.memory)} className="btn btn-secondary btn-sm">
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
                    </button>
                  </div>
                ) : bothDone && runs.off?.diagnosis && runs.on?.diagnosis ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 xl:grid-cols-2">
                      <DiagnosisCard diagnosis={runs.off.diagnosis} compact />
                      <DiagnosisCard
                        diagnosis={runs.on.diagnosis}
                        compact
                        recorded={runs.on.diagnosis.try_first ? recorded[runs.on.diagnosis.try_first.action] ?? null : null}
                        onOutcome={open ? (action, outcome) => void logAttempt(action, outcome) : undefined}
                      />
                    </div>
                    <ImpactRow off={runs.off.diagnosis} on={runs.on.diagnosis} />
                  </div>
                ) : primary?.diagnosis ? (
                  <ConsoleDiagnosis
                    diagnosis={primary.diagnosis}
                    recorded={primary.diagnosis.try_first ? recorded[primary.diagnosis.try_first.action] ?? null : null}
                    onOutcome={open && primary.diagnosis.memory_enabled ? (action, outcome) => void logAttempt(action, outcome) : undefined}
                  />
                ) : (
                  <div className="space-y-4">
                    {primary?.memory && primary.fix && primary.matched.length > 0 ? (
                      <FixHistory matched={primary.matched} worked={primary.fix.worked} failed={primary.fix.failed} final={false} strong={false} />
                    ) : (
                      <div className="space-y-2">
                        <div className="h-4 w-2/3 animate-pulse rounded-full bg-white/[0.07]" />
                        <div className="h-4 w-1/2 animate-pulse rounded-full bg-white/[0.07]" />
                      </div>
                    )}
                    <p className="text-xs text-muted">
                      {primary?.memory === false ? "Asking the model without memory..." : "The verified diagnosis appears when the investigation below finishes."}
                    </p>
                  </div>
                )}
                {runs.on?.diagnosis && runs.off === undefined && !running && open && (
                  <p className="mt-3 text-xs text-muted">Turn Memory off in the top bar to compare with a generic answer.</p>
                )}
              </Panel>

              {timelineRun && (timelineRun.running || timelineRun.error) && (
                <Panel title="Investigation" icon={<ListTree className="h-4 w-4 text-memory" aria-hidden="true" />} className="shrink-0">
                  <InvestigationTimeline
                    memory={timelineRun.memory}
                    steps={timelineRun.steps}
                    running={timelineRun.running}
                    startedAt={timelineRun.startedAt}
                    matchedCount={timelineRun.matched.length}
                  />
                </Panel>
              )}

              {experience ? (
                <ExperienceCard experience={experience} />
              ) : (
                <Panel title="Action log" icon={<ClipboardList className="h-4 w-4 text-memory" aria-hidden="true" />} className="shrink-0">
                  <ActionLog attempts={attempts} onLog={logAttempt} disabled={!open} />
                  {logError && <p className="mt-2 text-xs text-severity">{logError}</p>}
                </Panel>
              )}
            </>
          )}
        </div>

        <Panel title={incident ? "Why I think this" : "Team memory"} icon={<BrainCircuit className="h-4 w-4 text-memory" aria-hidden="true" />}>
          {memoryState === "idle" || memoryState === "off" ? (
            <MemorySnapshot overview={overview} memoryOn={memoryOn} />
          ) : (
            <MemoryPanel
              state={memoryState}
              matched={onRun?.matched ?? []}
              recalled={onRun?.recalled ?? []}
              cited={onRun?.diagnosis?.cited_incidents ?? []}
            />
          )}
        </Panel>
      </div>

      <footer className="glass-bar flex shrink-0 items-center gap-4 border-t border-white/[0.07] px-5 py-3">
        <LearningCurve points={learning} />
        <button type="button" disabled={!incident || !open || running} onClick={() => setResolveOpen(true)} className="btn btn-primary btn-lg shrink-0">
          <CheckCheck className="h-4 w-4" aria-hidden="true" /> Resolve and learn
        </button>
      </footer>

      {incident && (
        <ResolveDrawer key={incident.id} incident={incident} open={resolveOpen} onClose={() => setResolveOpen(false)} onResolved={onResolved} />
      )}
      <Toast message={toast} onDone={clearToast} />
    </div>
  );
}
