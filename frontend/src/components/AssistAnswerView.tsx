// FRIDAY's answer to a question, with the facts it rests on labelled by source: what the screen and the project show
// now (current), what the team experienced before (Hindsight, always with incident IDs), and, kept apart, what FRIDAY
// recommends. Used by the overlay chat and the console.
import { useState } from "react";
import { Check, ClipboardCopy, ExternalLink, X } from "lucide-react";
import { desktop } from "../lib/desktop";
import type { AssistAnswer, CodeFinding, EvidenceItem, FixRecord } from "../lib/types";
import { IncidentChip, LinkedText } from "./IncidentPeek";

const SOURCE_STYLE: Record<EvidenceItem["source"], string> = {
  SCREEN: "bg-sky-400/15 text-sky-300",
  INCIDENT: "bg-white/[0.08] text-ink",
  PROJECT: "bg-violet-400/15 text-violet-300",
  HINDSIGHT: "bg-success/15 text-success",
};

function SourceBadge({ source }: { source: EvidenceItem["source"] }) {
  return <span className={`shrink-0 rounded-md px-1.5 py-[1px] font-mono text-[9px] font-semibold tracking-wide ${SOURCE_STYLE[source]}`}>{source}</span>;
}

function OpenFinding({ finding }: { finding: CodeFinding }) {
  const [status, setStatus] = useState<string | null>(null);
  async function open() {
    if (desktop) {
      const result = await desktop.openFile(finding.abs_path, finding.line);
      setStatus(result.ok ? result.message : `${result.message} Path: ${finding.abs_path}:${finding.line}`);
      return;
    }
    try {
      await navigator.clipboard.writeText(`${finding.abs_path}:${finding.line}`);
      setStatus("Path copied.");
    } catch {
      setStatus(`${finding.abs_path}:${finding.line}`);
    }
  }
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button type="button" onClick={() => void open()} className="btn btn-secondary !px-2 !py-0.5 text-[11px]">
        {desktop ? <ExternalLink className="h-3 w-3" aria-hidden="true" /> : <ClipboardCopy className="h-3 w-3" aria-hidden="true" />}
        {desktop ? "Open file" : "Copy path"}
      </button>
      {status && <span className="text-[10px] text-muted">{status}</span>}
    </span>
  );
}

/** Same action in several incidents is one row. */
function grouped(records: FixRecord[]): { action: string; incidents: string[] }[] {
  const rows: { action: string; incidents: string[] }[] = [];
  for (const r of records) {
    const row = rows.find((x) => x.action.toLowerCase() === r.action.toLowerCase());
    if (row) {
      if (!row.incidents.includes(r.incident_id)) row.incidents.push(r.incident_id);
    } else rows.push({ action: r.action, incidents: [r.incident_id] });
  }
  return rows.sort((a, b) => b.incidents.length - a.incidents.length).slice(0, 3);
}

export default function AssistAnswerView({ answer, compact = false }: { answer: AssistAnswer; compact?: boolean }) {
  const findingAt = (location: string | null) => answer.findings.find((f) => `${f.path}:${f.line}` === location) ?? null;
  const showTried = ["previous_fix", "why_not", "history", "cause", "exact_change"].includes(answer.intent) && !answer.no_match;
  const worked = grouped(answer.worked);
  const failed = grouped(answer.failed);
  const text = compact ? "text-[13px] leading-5" : "text-sm leading-6";

  return (
    <div className="space-y-3">
      <p className={`${text} text-ink`}>
        <LinkedText text={answer.answer} />
      </p>

      {(answer.current.length > 0 || answer.history.length > 0) && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">What FRIDAY found</p>
          <ul className="space-y-1.5">
            {[...answer.current, ...answer.history].map((item, i) => {
              const finding = item.source === "PROJECT" ? findingAt(item.location) : null;
              return (
                <li key={`${item.source}-${i}`} className="flex items-start gap-2 text-xs">
                  <SourceBadge source={item.source} />
                  <span className={`min-w-0 flex-1 ${item.source === "SCREEN" ? "font-mono text-[11px]" : ""} text-ink/90`}>
                    {item.source === "HINDSIGHT" && item.incident_id && !item.text.includes(item.incident_id) && <IncidentChip id={item.incident_id} />}{" "}
                    <LinkedText text={item.text} />
                  </span>
                  {finding && <OpenFinding finding={finding} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {showTried && (worked.length > 0 || failed.length > 0) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {worked.length > 0 && (
            <ul className="space-y-1">
              <li className="text-[10px] font-semibold uppercase tracking-[0.08em] text-success">Worked before</li>
              {worked.map((w) => (
                <li key={w.action} className="flex items-start gap-1.5 text-[11px] text-ink">
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-hidden="true" />
                  <span>
                    {w.action} {w.incidents.map((id) => <IncidentChip key={id} id={id} tone="success" />)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {failed.length > 0 && (
            <ul className="space-y-1">
              <li className="text-[10px] font-semibold uppercase tracking-[0.08em] text-severity">Failed before</li>
              {failed.map((f) => (
                <li key={f.action} className="flex items-start gap-1.5 text-[11px] text-ink">
                  <X className="mt-0.5 h-3 w-3 shrink-0 text-severity" aria-hidden="true" />
                  <span>
                    {f.action} {f.incidents.map((id) => <IncidentChip key={id} id={id} tone="severity" />)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {answer.recommendation && (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">Recommendation</p>
          <p className="mt-0.5 text-xs leading-5 text-ink">
            <LinkedText text={answer.recommendation} />
          </p>
          {answer.next_step && <p className="mt-1 text-[11px] text-muted">Next step: {answer.next_step}</p>}
        </div>
      )}

      {(answer.project_error || answer.degraded) && (
        <p className="text-[11px] text-amber-300">
          {answer.project_error ?? "The language model was unavailable; this is Hindsight's reasoning as text."}
        </p>
      )}
    </div>
  );
}
