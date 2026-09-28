import { useState, type FormEvent } from "react";
import { CircleAlert, CircleCheck, CircleDot, Plus } from "lucide-react";
import type { AttemptLogged, Outcome } from "../lib/types";

const ICON: Record<Outcome, JSX.Element> = {
  worked: <CircleCheck className="h-4 w-4 text-success" aria-label="worked" />,
  failed: <CircleAlert className="h-4 w-4 text-severity" aria-label="failed" />,
  partial: <CircleDot className="h-4 w-4 text-amber-400" aria-label="partial" />,
};

export default function ActionLog({ attempts, onLog, disabled }: {
  attempts: AttemptLogged[];
  onLog: (action: string, outcome: Outcome, notes: string) => Promise<boolean>;
  disabled: boolean;
}) {
  const [action, setAction] = useState("");
  const [notes, setNotes] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("failed");
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (action.trim().length < 3 || saving) return;
    setSaving(true);
    const ok = await onLog(action.trim(), outcome, notes.trim());
    setSaving(false);
    if (ok) {
      setAction("");
      setNotes("");
    }
  }

  return (
    <div className="space-y-3">
      {attempts.length > 0 && (
        <ul className="space-y-1.5">
          {attempts.map((a) => (
            <li key={a.id} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 shrink-0">{ICON[a.outcome]}</span>
              <span className="text-ink">
                {a.action}
                {a.notes && <span className="text-muted"> ({a.notes})</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex flex-col gap-2">
        <input
          value={action}
          onChange={(e) => setAction(e.target.value)}
          disabled={disabled}
          placeholder="What did you try?"
          className="rounded-lg glass-well px-2.5 py-1.5 text-xs text-ink placeholder:text-muted/60 disabled:opacity-40"
        />
        <div className="flex gap-2">
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={disabled}
            placeholder="Note (optional)"
            className="min-w-0 flex-1 rounded-lg glass-well px-2.5 py-1.5 text-xs text-ink placeholder:text-muted/60 disabled:opacity-40"
          />
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as Outcome)}
            disabled={disabled}
            className="rounded-lg glass-well px-2 py-1.5 text-xs text-ink disabled:opacity-40"
          >
            <option value="failed">Failed</option>
            <option value="worked">Worked</option>
            <option value="partial">Partial</option>
          </select>
          <button
            type="submit"
            disabled={disabled || saving || action.trim().length < 3}
            className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-ink hover:border-memory/50 disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Log
          </button>
        </div>
      </form>
    </div>
  );
}
