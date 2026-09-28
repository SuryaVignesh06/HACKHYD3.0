import { Ban, BrainCircuit, CircleCheck, CircleX, FileText, ShieldCheck, ShieldQuestion, ThumbsDown, ThumbsUp } from "lucide-react";
import { duration } from "../lib/format";
import type { Diagnosis, Outcome } from "../lib/types";
import { IncidentChip, LinkedText } from "./IncidentPeek";
import MarkdownLite from "./MarkdownLite";
import CheckHere from "./CheckHere";
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
    <div className={`space-y-4 rounded-2xl border p-4 ${memory ? "border-memory/30 bg-black/30 shadow-[inset_0_1px_0_rgba(20,184,166,0.15)]" : "border-border bg-black/20"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wide ${memory ? "text-memory" : "text-muted"}`}>
          <BrainCircuit className="h-4 w-4" aria-hidden="true" />
          {memory ? "With memory" : "Without memory"}
        </span>
        <div className="flex items-center gap-3">
          {memory &&
            (diagnosis.strong_match ? (
              <span className="flex items-center gap-1 rounded bg-memory/10 px-1.5 py-0.5 text-[11px] text-memory">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Precedent confirmed
              </span>
            ) : (
              <span className="flex items-center gap-1 rounded bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-300">
                <ShieldQuestion className="h-3.5 w-3.5" aria-hidden="true" /> No strong precedent
              </span>
            ))}
          <span className="font-mono text-[11px] text-muted">{duration(diagnosis.latency_ms)}</span>
        </div>
      </div>

      <div className="space-y-2">
        <p className={`text-sm leading-6 ${memory ? "text-ink" : "text-muted"}`}>
          <LinkedText text={diagnosis.summary} />
        </p>
        <div className="flex items-center gap-2 text-xs text-muted">
          Confidence <ConfidenceBar value={diagnosis.confidence} tone={memory ? "memory" : "muted"} />
        </div>
      </div>

      {!compact && diagnosis.hypotheses.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted">Hypotheses</p>
          <ul className="space-y-1.5">
            {diagnosis.hypotheses.map((h) => (
              <li key={h.cause} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono text-muted">{Math.round(h.confidence * 100)}%</span>
                <span className={memory ? "text-ink" : "text-muted"}>{h.cause}</span>
                {h.evidence.length > 0 && <Chips ids={h.evidence} tone="memory" />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {diagnosis.try_first && (
        <div className={`space-y-2 rounded-xl border p-3 ${memory ? "border-success/30 bg-success/5" : "border-border"}`}>
          <p className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${memory ? "text-success" : "text-muted"}`}>
            <CircleCheck className="h-4 w-4" aria-hidden="true" /> Try first
          </p>
          <p className={`text-sm ${memory ? "text-ink" : "text-muted"}`}>{diagnosis.try_first.action}</p>
          {diagnosis.try_first.evidence.length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              Worked in {diagnosis.try_first.evidence.length} incident{diagnosis.try_first.evidence.length === 1 ? "" : "s"}:
              <Chips ids={diagnosis.try_first.evidence} tone="success" />
            </p>
          )}
          {onOutcome && (
            <div className="flex items-center gap-2 pt-1">
              {recorded ? (
                <span className={`text-xs ${recorded === "worked" ? "text-success" : "text-severity"}`}>
                  Recorded as {recorded === "worked" ? "worked" : "did not work"} and saved to memory.
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onOutcome(diagnosis.try_first?.action ?? "", "worked")}
                    className="flex items-center gap-1.5 rounded-md border border-success/40 px-2.5 py-1 text-xs text-success hover:bg-success/10"
                  >
                    <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" /> Worked
                  </button>
                  <button
                    type="button"
                    onClick={() => onOutcome(diagnosis.try_first?.action ?? "", "failed")}
                    className="flex items-center gap-1.5 rounded-md border border-severity/40 px-2.5 py-1 text-xs text-severity hover:bg-severity/10"
                  >
                    <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" /> Didn't work
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {!compact && <CheckHere findings={diagnosis.findings ?? []} project={diagnosis.project ?? null} />}

      {diagnosis.avoid.length > 0 && (
        <div className={`space-y-2.5 rounded-xl border p-3 ${memory ? "border-severity/30 bg-severity/5" : "border-border"}`}>
          <p className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${memory ? "text-severity" : "text-muted"}`}>
            <Ban className="h-4 w-4" aria-hidden="true" /> {memory ? "Avoid: failed before" : "Avoid"}
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
    </div>
  );
}
