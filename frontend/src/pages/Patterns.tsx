import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Brain, Layers, Loader2 } from "lucide-react";
import { LinkedText } from "../components/IncidentPeek";
import MarkdownLite from "../components/MarkdownLite";
import { api } from "../lib/api";
import { dateWithAge } from "../lib/format";
import type { ApiError, PatternsResponse } from "../lib/types";

export default function Patterns() {
  const [data, setData] = useState<PatternsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    void api.patterns().then((r) => (r.ok ? setData(r.data) : setError(r.error)));
  }, []);

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mx-auto max-w-5xl space-y-5">
        <div>
          <h1 className="flex items-center gap-2 text-sm font-semibold">
            <Layers className="h-4 w-4 text-memory" aria-hidden="true" /> Recurring failure patterns
          </h1>
          <p className="mt-1 text-xs text-muted">
            Hindsight consolidates retained incidents into observations on its own. The ones below span more than one incident.
          </p>
        </div>

        {error ? (
          <p className="text-sm text-severity">{error.message}</p>
        ) : !data ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading observations and asking Hindsight to reflect across all
            incidents...
          </p>
        ) : (
          <>
            <section className="glass p-5">
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-memory">
                <Brain className="h-4 w-4" aria-hidden="true" /> Hindsight reflect across {data.memory_count ?? "all"} memories
              </p>
              {data.summary ? (
                <div className="text-sm leading-6 text-ink">
                  <MarkdownLite text={data.summary} />
                </div>
              ) : (
                <p className="text-sm text-muted">Hindsight reflect is unavailable right now; the observations below are still current.</p>
              )}
            </section>

            <section className="space-y-2">
              <p className="text-xs text-muted">
                {data.patterns.length} cross-incident observations out of {data.observation_count}
              </p>
              {data.patterns.length === 0 ? (
                <p className="text-sm text-muted">No cross-incident observations yet. Hindsight forms them as more incidents are resolved.</p>
              ) : (
                <ul className="space-y-2">
                  {data.patterns.map((p, i) => (
                    <motion.li
                      key={p.text}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2, delay: Math.min(i, 10) * 0.06 }}
                      className="glass p-4"
                    >
                      <p className="text-sm leading-6 text-ink">
                        <LinkedText text={p.text} />
                      </p>
                      <p className="mt-1.5 text-[11px] text-muted">
                        {p.incident_ids.length} incidents · supported by {p.proof_count} memories
                        {p.updated_at ? ` · updated ${dateWithAge(p.updated_at)}` : ""}
                      </p>
                    </motion.li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
