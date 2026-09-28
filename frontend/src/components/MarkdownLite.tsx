import type { ReactNode } from "react";
import { LinkedText } from "./IncidentPeek";

/** Inline markdown: **bold**, `code`, and incident IDs as chips. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return (
            <strong key={i} className="font-semibold text-ink">
              <LinkedText text={part.slice(2, -2)} />
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return (
            <code key={i} className="rounded bg-bg px-1 font-mono text-[0.9em] text-ink">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <LinkedText key={i} text={part} />;
      })}
    </>
  );
}

/**
 * Renders the small markdown subset Hindsight reflect answers use (headings, bullets, numbered
 * lists, tables, bold, inline code). Written in place of a markdown library to keep the dependency list fixed.
 */
export default function MarkdownLite({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let table: string[][] | null = null;

  const flushTable = () => {
    if (!table || table.length === 0) {
      table = null;
      return;
    }
    const [header = [], ...rows] = table;
    blocks.push(
      <div key={blocks.length} className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-muted">
              {header.map((cell, i) => (
                <th key={i} className="border-b border-border px-2 py-1.5 font-medium">
                  <Inline text={cell} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-b border-border align-top">
                {row.map((cell, c) => (
                  <td key={c} className="px-2 py-1.5">
                    <Inline text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    table = null;
  };

  const flush = () => {
    flushTable();
    if (!list) return;
    const items = list.items.map((item, i) => (
      <li key={i}>
        <Inline text={item} />
      </li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={blocks.length} className="list-decimal space-y-1 pl-5">{items}</ol>
      ) : (
        <ul key={blocks.length} className="list-disc space-y-1 pl-5">{items}</ul>
      ),
    );
    list = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("|")) {
      if (/^\|?[\s:|-]+\|?$/.test(line.trim())) continue; // header separator row
      if (!table) {
        flush();
        table = [];
      }
      table.push(line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
      continue;
    }
    flushTable();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[*-]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)?.[1] ?? "");
      continue;
    }
    flush();
    if (!line.trim() || /^([-*_])\1{2,}$/.test(line.trim())) continue;
    if (heading) {
      blocks.push(
        <p key={blocks.length} className="pt-2 font-semibold text-ink">
          <Inline text={heading[1] ?? ""} />
        </p>,
      );
    } else {
      blocks.push(
        <p key={blocks.length}>
          <Inline text={line} />
        </p>,
      );
    }
  }
  flush();
  return <div className="space-y-2">{blocks}</div>;
}
