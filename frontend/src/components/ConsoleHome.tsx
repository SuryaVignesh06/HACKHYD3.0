// The console's hero (the orb and the FRIDAY wordmark) and the idle workspace: what memory holds right now and
// the demo incidents, each of which can replay its monitoring signals first.
import type { MutableRefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Radio } from "lucide-react";
import type { AudioFeatures } from "../lib/voice";
import type { DemoAlert, DemoSignal } from "../lib/types";
import Orb, { type OrbProps } from "./Orb";
import { SeverityBadge } from "./ui";

export interface DemoChoice {
  key: string;
  label: string;
  title: string;
  service: string;
  severity: string;
  alertText: string;
  signals: DemoSignal[];
}

/** Demo alerts as choices; a follow-up alert (same failure on another service) becomes its own choice. */
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

type OrbState = Pick<OrbProps, "colors" | "speed" | "waveHeight">;

export function FridayHero({ orb, audio, compact }: { orb: OrbState; audio?: MutableRefObject<AudioFeatures>; compact: boolean }) {
  const size = compact ? 92 : 168;
  return (
    <div className="flex flex-col items-center text-center">
      <motion.div
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 200, damping: 18 }}
      >
        <Orb size={size} density={90} {...orb} audio={audio} />
      </motion.div>
      <h1 className={`${compact ? "mt-1 text-2xl" : "mt-3 text-4xl"} font-light tracking-[0.5em] text-ink`} style={{ marginRight: "-0.5em" }}>
        FRIDAY
      </h1>
      <p className={`${compact ? "mt-1 text-sm" : "mt-2 text-[15px]"} text-muted`}>Engineering memory, when you need it.</p>
    </div>
  );
}

export function IdleWorkspace({ demos, busy, onDiagnose, onSimulate }: {
  demos: DemoChoice[];
  busy: boolean;
  onDiagnose: (demo: DemoChoice) => void;
  onSimulate: (demo: DemoChoice) => void;
}) {
  const quick = demos;

  return (
    <div className="space-y-5">
      {quick.length > 0 && (
        <section className="panel p-5">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-medium text-ink">Try an incident</h2>
            <p className="text-xs text-muted">Simulate replays the monitoring signals first, as if the pager fired.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {quick.map((demo, i) => (
              <motion.div
                key={demo.key}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 + i * 0.06 }}
                className="panel-inset panel-button flex flex-col justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={demo.severity} />
                    <span className="truncate font-mono text-[11px] text-muted">{demo.service}</span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm leading-snug text-ink">{demo.title}</p>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-muted/70">{demo.label}</span>
                  <div className="flex gap-1.5">
                    {demo.signals.length > 0 && (
                      <button type="button" disabled={busy} onClick={() => onSimulate(demo)} className="btn btn-ghost btn-sm" title="Replay the monitoring signals, then investigate">
                        <Radio className="h-3.5 w-3.5 text-severity" aria-hidden="true" /> Simulate
                      </button>
                    )}
                    <button type="button" disabled={busy} onClick={() => onDiagnose(demo)} className="btn btn-secondary btn-sm">
                      Investigate <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const LEVEL_TONE: Record<DemoSignal["level"], string> = {
  info: "text-muted",
  warn: "text-amber-300",
  critical: "text-severity",
};

/** The simulator's replay, labelled as simulated so nobody mistakes it for live monitoring. */
export function SignalFeed({ demo, signals }: { demo: DemoChoice; signals: DemoSignal[] }) {
  return (
    <section className="panel p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[15px] font-medium text-ink">
          <Radio className="h-4 w-4 animate-pulse text-severity" aria-hidden="true" /> Simulated signals
        </h2>
        <span className="font-mono text-[11px] text-muted">
          {demo.label} · {demo.service}
        </span>
      </div>
      <ul className="code-well mt-4 space-y-1 p-3 font-mono text-xs">
        <AnimatePresence initial={false}>
          {signals.map((s) => (
            <motion.li key={s.at_ms} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.18 }} className={LEVEL_TONE[s.level]}>
              {s.text}
            </motion.li>
          ))}
        </AnimatePresence>
        {signals.length < demo.signals.length && <li className="animate-pulse text-muted/60">waiting for the next signal...</li>}
      </ul>
    </section>
  );
}
