import { useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BrainCircuit, CircleAlert, CircleCheck, Loader2, Save, X } from "lucide-react";
import { api } from "../lib/api";
import type { ExperienceCaptured, IncidentCreated, PostmortemDraft } from "../lib/types";
import { LinkedText } from "./IncidentPeek";

function Field({ label, value, onChange, rows = 3 }: { label: string; value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="resize-y rounded-lg glass-well p-2.5 text-sm leading-5 text-ink"
      />
    </label>
  );
}

export function ExperienceCard({ experience }: { experience: ExperienceCaptured }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-4 rounded-lg border border-memory/40 bg-memory/5 p-4"
    >
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-memory">
        <BrainCircuit className="h-4 w-4" aria-hidden="true" /> FRIDAY learned
      </p>
      <div className="space-y-1 text-sm">
        <p className="text-xs text-muted">Pattern</p>
        <p className="text-ink">
          <LinkedText text={experience.pattern} />
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <p className="text-xs text-muted">Worked</p>
          {experience.worked_fixes.map((f) => (
            <p key={f} className="flex items-start gap-1.5 text-xs text-ink">
              <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
              {f}
            </p>
          ))}
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted">Failed</p>
          {experience.failed_fixes.length === 0 ? (
            <p className="text-xs text-muted">none recorded</p>
          ) : (
            experience.failed_fixes.map((f) => (
              <p key={f} className="flex items-start gap-1.5 text-xs text-ink">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-severity" aria-hidden="true" />
                {f}
              </p>
            ))
          )}
        </div>
      </div>
      <p className="text-xs text-muted">
        {experience.memory_retained ? (
          <>
            Saved to Hindsight as <span className="font-mono text-ink">{experience.incident_id}</span>. Your resolution is now available for future
            incidents.
          </>
        ) : (
          <span className="text-severity">Saved locally, but Hindsight was unavailable, so memory was not updated.</span>
        )}
      </p>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted hover:text-ink">Exact text retained</summary>
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg glass-well p-2.5 font-mono text-[11px] leading-4 text-ink">
          {experience.retained_text}
        </pre>
      </details>
    </motion.div>
  );
}

export default function ResolveDrawer({ incident, open, onClose, onResolved }: {
  incident: IncidentCreated;
  open: boolean;
  onClose: () => void;
  onResolved: (experience: ExperienceCaptured) => void;
}) {
  const [draft, setDraft] = useState<PostmortemDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [followUps, setFollowUps] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [experience, setExperience] = useState<ExperienceCaptured | null>(null);

  useEffect(() => {
    if (!open || draft || experience) return;
    let cancelled = false;
    setLoadError(null);
    void api.postmortemDraft(incident.id).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setDraft(result.data);
        setFollowUps(result.data.follow_ups.join("\n"));
      } else {
        setLoadError(result.error.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, draft, experience, incident.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft || saving) return;
    setSaving(true);
    setSaveError(null);
    const result = await api.resolve(incident.id, {
      summary: draft.summary,
      root_cause: draft.root_cause,
      fix: draft.fix,
      follow_ups: followUps.split("\n").map((l) => l.trim()).filter(Boolean),
      ttr_minutes: draft.ttr_minutes,
    });
    setSaving(false);
    if (result.ok) {
      setExperience(result.data);
      onResolved(result.data);
    } else {
      setSaveError(result.error.message);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-30 bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside
            role="dialog"
            aria-label="Resolve incident"
            className="fixed right-0 top-0 z-40 flex h-full w-full max-w-xl flex-col border-l glass-strong"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <p className="text-sm font-semibold">
                Resolve <span className="font-mono text-memory">{incident.id}</span>
              </p>
              <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-muted hover:bg-bg hover:text-ink">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {experience ? (
                <ExperienceCard experience={experience} />
              ) : loadError ? (
                <p className="text-sm text-severity">{loadError}</p>
              ) : !draft ? (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Drafting the postmortem from this session...
                </p>
              ) : (
                <form onSubmit={submit} className="space-y-4">
                  <p className="text-xs text-muted">
                    {draft.drafted_by === "session"
                      ? "The language model was unavailable, so this draft was built from the recorded attempts. Edit before saving."
                      : `Drafted by ${draft.drafted_by} from this session. Edit anything before saving.`}
                  </p>
                  <Field label="Summary" value={draft.summary} onChange={(v) => setDraft({ ...draft, summary: v })} />
                  <Field label="Root cause" value={draft.root_cause} onChange={(v) => setDraft({ ...draft, root_cause: v })} rows={4} />
                  <Field label="Fix that worked" value={draft.fix} onChange={(v) => setDraft({ ...draft, fix: v })} rows={2} />
                  <Field label="Follow-ups (one per line)" value={followUps} onChange={setFollowUps} rows={3} />
                  <label className="flex items-center gap-2 text-xs text-muted">
                    Time to resolve (minutes)
                    <input
                      type="number"
                      min={0}
                      value={draft.ttr_minutes}
                      onChange={(e) => setDraft({ ...draft, ttr_minutes: Math.max(0, Number(e.target.value) || 0) })}
                      className="w-24 rounded-lg glass-well px-2 py-1 font-mono text-sm text-ink"
                    />
                  </label>
                  {saveError && <p className="text-sm text-severity">{saveError}</p>}
                  <button
                    type="submit"
                    disabled={saving || draft.fix.trim().length < 3 || draft.root_cause.trim().length < 5}
                    className="flex w-full items-center justify-center gap-2 rounded-md bg-memory px-3 py-2 text-sm font-medium text-bg hover:bg-memory/90 disabled:opacity-40"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
                    {saving ? "Saving to Hindsight memory..." : "Resolve and save to memory"}
                  </button>
                </form>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
