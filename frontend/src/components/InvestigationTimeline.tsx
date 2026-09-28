import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Brain, CircleCheck, FileSearch, FolderSearch, ListChecks, Loader2, ScanText, Sparkles } from "lucide-react";
import { duration } from "../lib/format";
import type { InvestigationStep, StepName } from "../lib/types";

const STEP_META: Record<StepName, { label: string; icon: JSX.Element; running: (matched: number) => string }> = {
  parse: { label: "Read the alert", icon: <ScanText className="h-4 w-4" />, running: () => "Reading the alert..." },
  recall: {
    label: "Hindsight recall",
    icon: <FileSearch className="h-4 w-4" />,
    running: () => "Searching past incidents in Hindsight memory...",
  },
  evidence: { label: "Check the fix log", icon: <ListChecks className="h-4 w-4" />, running: () => "Checking what was tried before..." },
  inspect: {
    label: "Inspect the project",
    icon: <FolderSearch className="h-4 w-4" />,
    running: () => "Looking for the settings past fixes changed...",
  },
  reflect: {
    label: "Hindsight reflect",
    icon: <Brain className="h-4 w-4" />,
    running: (matched) =>
      matched > 0 ? `Hindsight is reasoning over ${matched} matching incidents...` : "Hindsight is reasoning over the bank...",
  },
  diagnosis: {
    label: "Diagnosis",
    icon: <Sparkles className="h-4 w-4" />,
    running: () => "Formatting and verifying every citation...",
  },
};

export default function InvestigationTimeline({ memory, steps, running, startedAt, matchedCount }: {
  memory: boolean;
  steps: InvestigationStep[];
  running: boolean;
  startedAt: number;
  matchedCount: number;
}) {
  const order: StepName[] = memory ? ["parse", "recall", "evidence", "inspect", "reflect", "diagnosis"] : ["parse", "diagnosis"];
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running]);

  const done = new Map(steps.map((s) => [s.name, s]));
  const current = running ? order.find((name) => !done.has(name)) : undefined;

  return (
    <ol className="space-y-1.5">
      {order.map((name) => {
        const step = done.get(name);
        const meta = STEP_META[name];
        const isCurrent = name === current;
        if (!step && !isCurrent) {
          return (
            <li key={name} className="flex items-center gap-3 px-2 py-1.5 text-xs text-muted/50">
              <span className="text-border">{meta.icon}</span>
              {meta.label}
            </li>
          );
        }
        return (
          <motion.li
            key={name}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className={`flex items-start gap-3 rounded-md px-2 py-1.5 text-xs ${isCurrent ? "bg-memory/5" : ""}`}
          >
            <span className={`mt-0.5 ${step ? "text-success" : "text-memory"}`}>
              {step ? <CircleCheck className="h-4 w-4" aria-hidden="true" /> : <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 font-medium text-ink">
                  <span className="text-muted">{meta.icon}</span>
                  {meta.label}
                </span>
                <span className="font-mono text-muted">
                  {step ? duration(step.duration_ms) : duration(Math.max(0, now - startedAt))}
                </span>
              </div>
              <p className={`mt-0.5 ${step ? "text-muted" : "text-memory"}`}>{step ? step.detail : meta.running(matchedCount)}</p>
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}
