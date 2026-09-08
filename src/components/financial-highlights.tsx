"use client";

import { cn } from "@/lib/utils";
import type {
  FinancialHighlights,
  HighlightColumn,
  HighlightRow,
} from "@/lib/markets/us/edgar-highlights";

function fmt(v: number | null, format: "money" | "pct" | "eps"): string {
  if (v == null || !Number.isFinite(v)) return "–";
  if (format === "eps") {
    return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (format === "pct") {
    return v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  // money — 백만 단위
  return (v / 1e6).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function HighlightGrid({
  columns,
  rows,
}: {
  columns: HighlightColumn[];
  rows: HighlightRow[];
}) {
  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[760px] border-separate border-spacing-0 text-[15px]">
          <thead>
            <tr>
              <th className="bg-muted/50 sticky left-0 z-10 border-b px-3 py-2 text-left" />
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    "text-muted-foreground border-b px-3 py-2 text-right font-medium whitespace-nowrap",
                    c.kind === "estimate" && "text-muted-foreground/70 italic",
                    c.kind === "ltm" && "bg-muted/40",
                  )}
                >
                  <div>{c.label}</div>
                  <div className="text-muted-foreground/60 text-xs font-normal">
                    {c.date.replace(/-/g, "/").slice(2)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              if (r.spacer) {
                return (
                  <tr key={r.key}>
                    <td colSpan={columns.length + 1} className="h-2.5" />
                  </tr>
                );
              }
              const emBg = "bg-[oklch(0.94_0.045_67)] dark:bg-[oklch(0.32_0.05_55)]";
              return (
                <tr
                  key={r.key}
                  className={cn(r.emphasis && "font-semibold", !r.indent && "hover:bg-muted/20")}
                >
                  <td
                    className={cn(
                      "sticky left-0 z-10 px-3 py-1.5 whitespace-nowrap",
                      r.emphasis ? `${emBg} border-t` : "bg-background",
                      r.indent
                        ? "text-muted-foreground/80 pl-6 text-sm"
                        : "text-foreground/90",
                    )}
                  >
                    {r.label}
                  </td>
                  {r.values.map((v, i) => (
                    <td
                      key={i}
                      className={cn(
                        "tnum px-3 py-1.5 text-right whitespace-nowrap",
                        r.emphasis && `${emBg} border-t`,
                        r.indent && "text-muted-foreground/70 text-[13px]",
                        columns[i]?.kind === "estimate" && "text-muted-foreground/60 italic",
                        columns[i]?.kind === "ltm" && !r.emphasis && "bg-muted/20",
                        v != null && v < 0 && !r.indent && "text-destructive",
                      )}
                    >
                      {fmt(v, r.format)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function FinancialHighlightsTable({ data }: { data: FinancialHighlights }) {
  const { columns, rows } = data;

  // 첫 spacer 기준으로 EV 브릿지 / 손익·현금흐름 분리
  const splitAt = rows.findIndex((r) => r.spacer);
  const evRows = splitAt >= 0 ? rows.slice(0, splitAt) : rows;
  const flowRows = splitAt >= 0 ? rows.slice(splitAt + 1) : [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">재무 하이라이트</h2>
        <span className="text-muted-foreground text-xs">
          단위: {data.unitLabel} · 12개월 결산 · 현재/LTM {data.asOfLtm}
        </span>
      </div>

      <HighlightGrid columns={columns} rows={evRows} />
      {flowRows.length > 0 && <HighlightGrid columns={columns} rows={flowRows} />}

      <ul className="text-muted-foreground/70 space-y-0.5 text-xs">
        {data.notes.map((n, i) => (
          <li key={i}>· {n}</li>
        ))}
      </ul>
    </section>
  );
}
