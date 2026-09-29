import { Ban, BrainCircuit, CircleCheck, CircleX, CloudOff, FileText, ShieldCheck, ShieldQuestion, ThumbsDown, ThumbsUp, Waves } from "lucide-react";
import { duration } from "../lib/format";
import type { Diagnosis, Outcome } from "../lib/types";
import { Evidence, FixHistory, NextSteps, Remembered, RootCause } from "./DiagnosisSections";
import { IncidentChip, LinkedText } from "./IncidentPeek";
import MarkdownLite from "./MarkdownLite";
import { ConfidenceBar } from "./ui";

function Chips({ ids, tone }: { ids: string[]; tone: "memory" | "severity" | "success" }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.map((id) => (
        <IncidentChip key={id} id={id} tone={tone} />
      ))}
    </span>
  );
}

/** The one-line statement of what this answer is based on, computed from the response. */
export function ModeLine({ diagnosis }: { diagnosis: Diagnosis }) {
  if (diagnosis.memory_unavailable) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-amber-300">
        <CloudOff className="h-3.5 w-3.5" aria-hidden="true" /> Hindsight unavailable. Diagnosis based only on the current context.
      </p>
    );
  }
  if (!diagnosis.memory_enabled) return <p className="text-xs text-muted">Diagnosis based only on the current context.</p>;
  const cited = diagnosis.cited_incidents.length;
  return (
    <p className="text-xs text-muted">
      {cited > 0
        ? `Diagnosis informed by ${cited} verified past incident${cited === 1 ? "" : "s"} out of ${diagnosis.matched.length} recalled from Hindsight.`
        : `Hindsight recalled ${diagnosis.matched.length} related incident${diagnosis.matched.length === 1 ? "" : "s"}, none confirmed as the same failure.`}
    </p>
  );
}

const OUTCOME_TEXT: Record<Outcome, string> = { worked: "worked", failed: "did not work", partial: "partially worked" };

export default function DiagnosisCard({ diagnosis, onOutcome, recorded, compact = false }: {
  diagnosis: Diagnosis;
  onOutcome?: (action: string, outcome: Outcome) => void;
  recorded?: Outcome | null;
  compact?: boolean;
}) {
  const memory = diagnosis.memory_enabled;

  if (diagnosis.degraded) {
    return (
      <div className="glass-well space-y-3 rounded-2xl p-4">
        <p className="flex items-center gap-2 text-xs text-amber-300">
          <FileText className="h-4 w-4" aria-hidden="true" />
          {memory
            ? "The language model was unavailable, so this is Hindsight's reflect answer as plain text."
            : "The language model was unavailable."}
        </p>
        <div className="text-sm leading-6 text-ink">
          <MarkdownLite text={diagnosis.summary} />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`space-y-5 rounded-[20px] border p-5 ${memory ? "border-memory/25 bg-gradient-to-b from-memory/[0.07] to-black/20" : "border-white/[0.07] bg-black/25"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] ${memory ? "text-memory" : "text-muted"}`}>
          {memory ? <BrainCircuit className="h-4 w-4" aria-hidden="true" /> : <Waves className="h-4 w-4" aria-hidden="true" />}
          {memory ? "With memory" : "Without memory"}
        </span>
        <div className="flex items-center gap-3">
          {memory &&
            (diagnosis.strong_match ? (
              <span className="flex items-center gap-1 rounded-full bg-memory/10 px-2 py-0.5 text-[11px] text-memory">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Precedent confirmed
              </span>
            ) : (
              <span className="flex items-center gap-1 rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-300">
                <ShieldQuestion className="h-3.5 w-3.5" aria-hidden="true" /> No strong precedent
              </span>
            ))}
          <span className="font-mono text-[11px] text-muted">{duration(diagnosis.latency_ms)}</span>
        </div>
      </div>

      {!compact && <Remembered diagnosis={diagnosis} />}

      <div className="space-y-2.5">
        {memory && diagnosis.strong_match && !compact && <p className="text-lg font-semibold tracking-tight text-ink">I've seen this before.</p>}
        <p className={`text-sm leading-6 ${memory ? "text-ink" : "text-muted"}`}>
          <LinkedText text={diagnosis.summary} />
        </p>
        <ModeLine diagnosis={diagnosis} />
        <div className="flex items-center gap-2 text-xs text-muted">
          Confidence <ConfidenceBar value={diagnosis.confidence} tone={memory ? "memory" : "muted"} />
        </div>
      </div>

      {!compact && memory && <RootCause diagnosis={diagnosis} />}

      {diagnosis.try_first && (
        <div className={memory ? "tile-success space-y-2" : "tile space-y-2"}>
          <p className={`eyebrow flex items-center gap-1.5 ${memory ? "!text-success" : ""}`}>
            <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" /> Try first
          </p>
          <p className={`text-sm leading-6 ${memory ? "text-ink" : "text-muted"}`}>{diagnosis.try_first.action}</p>
          {diagnosis.try_first.evidence.length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              Worked in {diagnosis.try_first.evidence.length} incident{diagnosis.try_first.evidence.length === 1 ? "" : "s"}:
              <Chips ids={diagnosis.try_first.evidence} tone="success" />
            </p>
          )}
          {onOutcome && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {recorded ? (
                <span className={`text-xs ${recorded === "worked" ? "text-success" : recorded === "partial" ? "text-amber-300" : "text-severity"}`}>
                  Recorded as {OUTCOME_TEXT[recorded]} and sent to memory.
                </span>
              ) : (
                <>
                  <button type="button" onClick={() => onOutcome(diagnosis.try_first?.action ?? "", "worked")} className="btn btn-success btn-sm">
                    <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" /> Worked
                  </button>
                  <button type="button" onClick={() => onOutcome(diagnosis.try_first?.action ?? "", "partial")} className="btn btn-amber btn-sm">
                    Partially
                  </button>
                  <button type="button" onClick={() => onOutcome(diagnosis.try_first?.action ?? "", "failed")} className="btn btn-danger btn-sm">
                    <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" /> Didn't work
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {diagnosis.avoid.length > 0 && (
        <div className={memory ? "tile-severity space-y-2.5" : "tile space-y-2.5"}>
          <p className={`eyebrow flex items-center gap-1.5 ${memory ? "!text-severity" : ""}`}>
            <Ban className="h-3.5 w-3.5" aria-hidden="true" /> {memory ? "Avoid: failed before" : "Avoid"}
          </p>
          <ul className="space-y-2.5">
            {diagnosis.avoid.map((item) => (
              <li key={item.action} className="space-y-1">
                <p className={`flex items-start gap-1.5 text-sm ${memory ? "text-ink" : "text-muted"}`}>
                  <CircleX className={`mt-0.5 h-4 w-4 shrink-0 ${memory ? "text-severity" : "text-muted"}`} aria-hidden="true" />
                  {item.action}
                </p>
                {item.evidence.length > 0 && (
                  <p className="flex flex-wrap items-center gap-1.5 pl-5 text-xs text-muted">
                    Failed in {item.evidence.length} incident{item.evidence.length === 1 ? "" : "s"}:
                    <Chips ids={item.evidence} tone="severity" />
                  </p>
                )}
                {!compact && (
                  <p className="pl-5 text-xs text-muted">
                    <LinkedText text={item.why} />
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!compact && memory && (
        <FixHistory matched={diagnosis.matched} worked={diagnosis.worked_fixes} failed={diagnosis.failed_fixes} final strong={diagnosis.strong_match} />
      )}
      {!compact && memory && <Evidence diagnosis={diagnosis} />}
      {!compact && <NextSteps diagnosis={diagnosis} />}
    </div>
  );
}
