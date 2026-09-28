import { useEffect, useMemo, useState } from "react";
import { History as HistoryIcon, Loader2, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { SeverityBadge } from "../components/ui";
import { api } from "../lib/api";
import { dateWithAge } from "../lib/format";
import type { ApiError, IncidentSummary } from "../lib/types";

export default function History() {
  const [rows, setRows] = useState<IncidentSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    void api.incidents().then((r) => (r.ok ? setRows(r.data) : setError(r.error)));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!rows || !q) return rows ?? [];
    return rows.filter((r) => `${r.id} ${r.title} ${r.service} ${r.root_cause ?? ""}`.toLowerCase().includes(q));
  }, [rows, query]);

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="flex items-center gap-2 text-sm font-semibold">
            <HistoryIcon className="h-4 w-4 text-memory" aria-hidden="true" /> Incident history
            {rows && <span className="font-normal text-muted">({rows.length})</span>}
          </h1>
          <label className="flex items-center gap-2 rounded-lg glass-well px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by ID, service or cause"
              className="w-64 bg-transparent text-xs text-ink placeholder:text-muted/60 focus:outline-none"
            />
          </label>
        </div>

        {error ? (
          <p className="text-sm text-severity">{error.message}</p>
        ) : !rows ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading incidents...
          </p>
        ) : (
          <div className="glass overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="px-3 py-2 font-normal">ID</th>
                  <th className="px-3 py-2 font-normal">Date</th>
                  <th className="px-3 py-2 font-normal">Service</th>
                  <th className="px-3 py-2 font-normal">Severity</th>
                  <th className="px-3 py-2 font-normal">Title and root cause</th>
                  <th className="px-3 py-2 font-normal">TTR</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr
                    key={row.id}
                    tabIndex={0}
                    onClick={() => navigate(`/incidents/${row.id}`)}
                    onKeyDown={(e) => e.key === "Enter" && navigate(`/incidents/${row.id}`)}
                    className="cursor-pointer border-t border-border align-top hover:bg-surface focus:bg-surface"
                  >
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-memory">
                      {row.id}
                      {row.source === "live" && <span className="ml-1.5 rounded bg-memory/10 px-1 text-[10px] text-memory">live</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted">{dateWithAge(row.created_at)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-muted">{row.service}</td>
                    <td className="px-3 py-2.5">
                      <SeverityBadge severity={row.severity} />
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="text-ink">{row.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-muted">{row.root_cause ?? (row.status === "open" ? "Open incident" : "")}</p>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-muted">{row.ttr_minutes !== null ? `${row.ttr_minutes} min` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
