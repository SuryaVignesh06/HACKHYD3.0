import type { ReactNode } from "react";

export function SeverityBadge({ severity }: { severity: string }) {
  const tone =
    severity === "SEV1"
      ? "bg-severity/15 text-severity"
      : severity === "SEV2"
        ? "bg-amber-400/15 text-amber-300"
        : "bg-slate-400/15 text-slate-300";
  return <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-medium ${tone}`}>{severity}</span>;
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
      <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
          {icon}
          {title}
        </h2>
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </section>
  );
}

export function ConfidenceBar({ value, tone = "memory" }: { value: number | null; tone?: "memory" | "muted" }) {
  const width = value === null ? 0 : Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-border">
        <div
          className={`h-full rounded-full transition-all duration-200 ${tone === "memory" ? "bg-memory" : "bg-muted"}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="font-mono text-xs text-muted">{value === null ? "n/a" : `${width}%`}</span>
    </div>
  );
}
