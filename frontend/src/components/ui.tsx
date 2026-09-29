import type { ReactNode } from "react";

export function SeverityBadge({ severity }: { severity: string }) {
  const tone =
    severity === "SEV1"
      ? "bg-severity/15 text-severity"
      : severity === "SEV2"
        ? "bg-amber-400/15 text-amber-300"
        : "bg-slate-400/15 text-slate-300";
  return <span className={`rounded-full px-2 py-[1px] font-mono text-[11px] font-medium ${tone}`}>{severity}</span>;
}

export function Panel({ title, icon, action, children, className = "" }: {
  title: string;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`glass flex min-h-0 flex-col overflow-hidden ${className}`}>
      <header className="flex items-center justify-between px-5 pb-1 pt-4">
        <h2 className="eyebrow flex items-center gap-2">
          {icon}
          {title}
        </h2>
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-3">{children}</div>
    </section>
  );
}

export function ConfidenceBar({ value, tone = "memory" }: { value: number | null; tone?: "memory" | "muted" }) {
  const width = value === null ? 0 : Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className={`h-full rounded-full transition-all duration-300 ${tone === "memory" ? "bg-gradient-to-r from-memory/70 to-memory" : "bg-muted"}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="font-mono text-xs text-muted">{value === null ? "n/a" : `${width}%`}</span>
    </div>
  );
}

/** A labelled number. Every value passed in must come from a real response. */
export function Stat({ label, value, tone = "text-ink", hint }: { label: string; value: ReactNode; tone?: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className={`font-mono text-2xl font-medium tracking-tight ${tone}`}>{value}</p>
      <p className="mt-0.5 truncate text-[11px] text-muted" title={hint}>
        {label}
      </p>
    </div>
  );
}

/** iOS-style switch. */
export function Switch({ on, onChange, label, disabled = false }: { on: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-40 ${on ? "bg-success" : "bg-white/15"}`}
    >
      <span
        className={`absolute left-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.4)] transition-transform duration-200 ${on ? "translate-x-4" : "translate-x-0"}`}
      />
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="whitespace-nowrap rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-[1px] font-mono text-[10px] text-muted shadow-[inset_0_-1px_0_rgba(0,0,0,0.4)]">
      {children}
    </kbd>
  );
}
