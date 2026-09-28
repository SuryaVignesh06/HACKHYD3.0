import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, CircleDot, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import { dateTime, dateWithAge, percent } from "../lib/format";
import type { ApiError, IncidentDetail, Outcome } from "../lib/types";
import { SeverityBadge } from "./ui";

const OUTCOME_ICON: Record<Outcome, JSX.Element> = {
  worked: <CircleCheck className="h-4 w-4 text-success" aria-label="worked" />,
  failed: <CircleAlert className="h-4 w-4 text-severity" aria-label="failed" />,
  partial: <CircleDot className="h-4 w-4 text-amber-400" aria-label="partial" />,
};

export default function IncidentDetailView({ incidentId }: { incidentId: string }) {
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    void api.incident(incidentId).then((result) => {
      if (cancelled) return;
      if (result.ok) setDetail(result.data);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [incidentId]);

  if (error) return <p className="text-sm text-severity">{error.message}</p>;
  if (!detail) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading {incidentId}...
      </p>
    );
  }

  return (
    <div className="space-y-6 text-sm">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={detail.severity} />
          <span className="font-mono text-xs text-muted">{detail.service}</span>
          <span className="text-xs text-muted">{dateWithAge(detail.created_at)}</span>
          <span className={`rounded px-1.5 py-0.5 text-[11px] ${detail.status === "resolved" ? "bg-success/10 text-success" : "bg-severity/10 text-severity"}`}>
            {detail.status}
          </span>
          {detail.on_call && <span className="text-xs text-muted">on call: {detail.on_call}</span>}
        </div>
        <h2 className="text-base font-semibold text-ink">{detail.title}</h2>
      </header>

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Alert</h3>
        <pre className="whitespace-pre-wrap rounded-lg glass-well p-3 font-mono text-xs text-ink">{detail.alert_text}</pre>
      </section>

      {(detail.summary || detail.root_cause) && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Postmortem</h3>
          {detail.summary && <p className="text-ink">{detail.summary}</p>}
          {detail.root_cause && (
            <p>
              <span className="text-muted">Root cause: </span>
              {detail.root_cause}
            </p>
          )}
          {detail.fix && (
            <p>
              <span className="text-muted">Fix: </span>
              {detail.fix}
            </p>
          )}
          {detail.ttr_minutes !== null && <p className="text-muted">Resolved in {detail.ttr_minutes} minutes.</p>}
          {detail.follow_ups.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-muted">
              {detail.follow_ups.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Fix attempts</h3>
        {detail.attempts.length === 0 ? (
          <p className="text-muted">No fix attempts recorded.</p>
        ) : (
          <ul className="space-y-2">
            {detail.attempts.map((attempt) => (
              <li key={attempt.id} className="flex gap-2 rounded-lg glass-well p-2.5">
                <span className="mt-0.5 shrink-0">{OUTCOME_ICON[attempt.outcome]}</span>
                <div>
                  <p className="text-ink">{attempt.action}</p>
                  {attempt.notes && <p className="text-xs text-muted">{attempt.notes}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.diagnoses.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Diagnoses</h3>
          <ul className="space-y-2">
            {detail.diagnoses.map((record) => (
              <li key={record.id} className="rounded-lg glass-well p-2.5">
                <p className="mb-1 text-xs text-muted">
                  {dateTime(record.created_at)} · {record.diagnosis.memory_enabled ? "with memory" : "without memory"} · confidence{" "}
                  {percent(record.diagnosis.confidence)} · {record.diagnosis.cited_incidents.length} citations
                </p>
                <p className="text-ink">{record.diagnosis.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
