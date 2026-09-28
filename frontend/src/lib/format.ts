export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function relativeAge(iso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks} weeks ago`;
  const months = Math.round(days / 30);
  return `${months} months ago`;
}

export function dateWithAge(iso: string | null): string {
  if (!iso) return "date unknown";
  return `${shortDate(iso)} · ${relativeAge(iso)}`;
}

export function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : `${Math.round(value * 100)}%`;
}

export function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Hindsight world facts look like "fact | When: ... | Involving: ..."; split the fact from its metadata. */
export function splitMemoryText(text: string): { fact: string; meta: string } {
  const [fact = text, ...rest] = text.split(" | ");
  return { fact, meta: rest.join(" · ") };
}
