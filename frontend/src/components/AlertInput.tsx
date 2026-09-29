import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Play, Radio, Search, SquarePen } from "lucide-react";
import type { DemoAlert, DemoSignal } from "../lib/types";

export const SERVICES = ["payments-api", "checkout-web", "ledger-worker", "notifications-svc", "auth-service", "search-api"];
const SEVERITIES = ["SEV1", "SEV2", "SEV3"];

export interface AlertDraft {
  alertText: string;
  service: string;
  severity: string;
}

export interface DemoChoice {
  key: string;
  label: string;
  title: string;
  service: string;
  severity: string;
  alertText: string;
  signals: DemoSignal[];
}

export function demoChoices(alerts: DemoAlert[]): DemoChoice[] {
  const choices: DemoChoice[] = alerts.map((a) => ({
    key: a.id,
    label: a.id,
    title: a.title,
    service: a.service,
    severity: a.severity,
    alertText: a.alert_text,
    signals: a.signals,
  }));
  for (const a of alerts) {
    if (a.follow_up_alert && a.follow_up_service) {
      choices.push({
        key: `${a.id}-follow-up`,
        label: `${a.id} follow-up`,
        title: `Follow-up on ${a.follow_up_service}`,
        service: a.follow_up_service,
        severity: a.severity,
        alertText: a.follow_up_alert,
        signals: [],
      });
    }
  }
  return choices;
}

const LEVEL_COLOR: Record<DemoSignal["level"], string> = {
  info: "text-muted",
  warn: "text-amber-300",
  critical: "text-severity",
};

export default function AlertInput({ draft, onDraftChange, demos, busy, onSubmit, onNewIncident, hasIncident, simulateRequest }: {
  draft: AlertDraft;
  onDraftChange: (draft: AlertDraft) => void;
  demos: DemoChoice[];
  busy: boolean;
  onSubmit: (draft: AlertDraft) => void;
  onNewIncident: () => void;
  hasIncident: boolean;
  simulateRequest?: { choice: DemoChoice; nonce: number } | null;
}) {
  const [simulating, setSimulating] = useState<string | null>(null);
  const [signals, setSignals] = useState<DemoSignal[]>([]);
  const timers = useRef<number[]>([]);
  const canSubmit = draft.alertText.trim().length > 0 && !busy;

  useEffect(() => {
    return () => timers.current.forEach((t) => window.clearTimeout(t));
  }, []);

  useEffect(() => {
    if (!simulateRequest) return;
    simulate(simulateRequest.choice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulateRequest?.nonce]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (canSubmit) onSubmit(draft);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  }

  function pick(choice: DemoChoice) {
    setSignals([]);
    onDraftChange({ alertText: choice.alertText, service: choice.service, severity: choice.severity });
  }

  /** Replays the demo's scripted monitoring signals, then opens the incident as if the pager fired. */
  function simulate(choice: DemoChoice) {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    setSignals([]);
    setSimulating(choice.key);
    onDraftChange({ alertText: "", service: choice.service, severity: choice.severity });
    choice.signals.forEach((signal) => {
      timers.current.push(window.setTimeout(() => setSignals((s) => [...s, signal]), signal.at_ms));
    });
    const last = Math.max(0, ...choice.signals.map((s) => s.at_ms)) + 700;
    timers.current.push(
      window.setTimeout(() => {
        const next = { alertText: choice.alertText, service: choice.service, severity: choice.severity };
        onDraftChange(next);
        setSimulating(null);
        onSubmit(next);
      }, last),
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div>
        <p className="eyebrow mb-2">Demo alerts</p>
        <div className="flex flex-col gap-1.5">
          {demos.map((choice) => {
            const isSelected = draft.alertText === choice.alertText;
            const hasSignals = choice.signals.length > 0;
            const isThisSimulating = simulating === choice.key;

            return (
              <div
                key={choice.key}
                onClick={() => !busy && pick(choice)}
                className={`group relative flex cursor-pointer flex-col gap-1 rounded-xl border p-2.5 transition-all ${
                  isSelected
                    ? "border-memory/50 bg-memory/[0.08] shadow-[0_0_12px_rgba(20,184,166,0.12)]"
                    : "border-white/[0.06] bg-white/[0.025] hover:border-white/[0.12] hover:bg-white/[0.05]"
                } ${busy ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="font-mono text-xs font-semibold text-ink">{choice.label}</span>
                    <span className="font-mono text-[10px] text-muted truncate">{choice.service}</span>
                  </div>

                  {hasSignals && (
                    <button
                      type="button"
                      disabled={busy || simulating !== null}
                      onClick={(e) => {
                        e.stopPropagation();
                        simulate(choice);
                      }}
                      title="Simulate incident: replay signals, then open"
                      className="flex items-center gap-1 rounded-md border border-severity/30 bg-severity/10 px-2 py-0.5 text-[10px] font-medium text-severity transition-colors hover:bg-severity/20 disabled:opacity-50"
                    >
                      <Radio className={`h-2.5 w-2.5 ${isThisSimulating ? "animate-pulse" : ""}`} aria-hidden="true" />
                      <span>Simulate</span>
                    </button>
                  )}
                </div>
                <p className="line-clamp-2 text-[11px] leading-snug text-muted group-hover:text-ink/80 transition-colors">
                  {choice.title}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      <AnimatePresence>
        {(simulating || signals.length > 0) && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="glass-well rounded-xl p-2.5"
          >
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
              <Radio className={`h-3 w-3 ${simulating ? "animate-pulse text-severity" : ""}`} aria-hidden="true" />
              Simulated signals
            </p>
            <ul className="space-y-1 font-mono text-[11px] leading-4">
              {signals.map((signal) => (
                <motion.li key={signal.text} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} className={LEVEL_COLOR[signal.level]}>
                  {signal.text}
                </motion.li>
              ))}
              {simulating && <li className="animate-pulse text-muted">watching...</li>}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      <label className="flex flex-col gap-1.5">
        <span className="eyebrow">Alert, log or stack trace</span>
        <textarea
          value={draft.alertText}
          onChange={(e) => onDraftChange({ ...draft, alertText: e.target.value })}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder="[FIRING] ... paste the alert or log lines here"
          className="glass-well h-24 resize-none rounded-xl p-3 font-mono text-xs leading-5 text-ink placeholder:text-muted/60 focus:border-memory/50"
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Service
          <select
            value={draft.service}
            onChange={(e) => onDraftChange({ ...draft, service: e.target.value })}
            className="glass-well rounded-xl px-2.5 py-1.5 font-mono text-xs text-ink"
          >
            {SERVICES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Severity
          <select
            value={draft.severity}
            onChange={(e) => onDraftChange({ ...draft, severity: e.target.value })}
            className="glass-well rounded-xl px-2.5 py-1.5 font-mono text-xs text-ink"
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex gap-2 pt-1 pb-1">
        <button
          type="submit"
          disabled={!canSubmit}
          className="btn btn-primary flex-1 py-2 text-xs font-semibold shadow-md shadow-teal-900/20"
        >
          <Search className="h-4 w-4" aria-hidden="true" /> Diagnose
          <span className="font-mono text-[10px] opacity-70">Ctrl+Enter</span>
        </button>
        {hasIncident && (
          <button
            type="button"
            onClick={onNewIncident}
            disabled={busy}
            title="Start a new incident"
            className="btn btn-secondary px-3"
          >
            <SquarePen className="h-3.5 w-3.5" aria-hidden="true" /> New
          </button>
        )}
      </div>
      {simulating && (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Play className="h-3 w-3" aria-hidden="true" /> The incident opens when the alert fires.
        </p>
      )}
    </form>
  );
}
