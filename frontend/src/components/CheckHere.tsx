import { useState } from "react";
import { ExternalLink, History, MapPin } from "lucide-react";
import { desktop } from "../lib/desktop";
import type { CodeFinding } from "../lib/types";
import { LinkedText } from "./IncidentPeek";

function Finding({ finding, project }: { finding: CodeFinding; project: string | null }) {
  const [result, setResult] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  async function open() {
    if (!desktop) return;
    setOpening(true);
    const outcome = await desktop.openFile(finding.abs_path, finding.line);
    setOpening(false);
    setResult(outcome.message);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs text-ink">
          {project && <span className="text-muted">{project}/</span>}
          {finding.path}
          <span className="text-amber-300">:{finding.line}</span>
        </p>
        {desktop ? (
          <button
            type="button"
            onClick={() => void open()}
            disabled={opening}
            className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-ink hover:border-memory/50 disabled:opacity-50"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> Open file
          </button>
        ) : (
          <span className="text-[11px] text-muted">Open it from the desktop app</span>
        )}
      </div>
      <pre className="overflow-x-auto rounded-lg glass-well py-1.5 font-mono text-[11px] leading-5">
        {finding.snippet.map((line) => (
          <div
            key={line.no}
            className={line.no === finding.line ? "border-l-2 border-amber-400 bg-amber-400/10 pr-3 text-ink" : "border-l-2 border-transparent pr-3 text-muted"}
          >
            <span className="inline-block w-9 select-none pr-2 text-right text-muted/60">{line.no}</span>
            {line.text}
          </div>
        ))}
      </pre>
      <p className="text-xs text-ink">
        <LinkedText text={finding.note} />
      </p>
      {finding.history.length > 0 && (
        <ul className="space-y-0.5">
          {finding.history.map((entry) => (
            <li key={entry} className="flex items-start gap-1.5 text-[11px] text-muted">
              <History className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <LinkedText text={entry} />
            </li>
          ))}
        </ul>
      )}
      {result && <p className="text-[11px] text-muted">{result}</p>}
    </div>
  );
}

/** Places in the authorized project that past fixes touched. Every line shown was read from disk. */
export default function CheckHere({ findings, project }: { findings: CodeFinding[]; project: string | null }) {
  if (findings.length === 0) return null;
  return (
    <div className="space-y-3 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-300">
        <MapPin className="h-4 w-4" aria-hidden="true" /> Check here
      </p>
      {findings.map((finding) => (
        <Finding key={`${finding.path}:${finding.line}`} finding={finding} project={project} />
      ))}
    </div>
  );
}
