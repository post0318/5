"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type {
  FinancialHighlights,
  HighlightColumn,
  HighlightRow,
} from "@/lib/markets/us/edgar-highlights";

type Scale = "million" | "billion";

function fmt(
  v: number | null,
  format: "money" | "pct" | "eps" | "mult",
  scale: Scale,
): string {
  if (v == null || !Number.isFinite(v)) return "–";
  if (format === "eps" || format === "mult") {
    return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (format === "pct") {
    return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // 백만 단위는 정수(소수점 없음), 10억(모바일) 단위는 소수 2자리
  const div = scale === "billion" ? 1e9 : 1e6;
  const frac = scale === "billion" ? 2 : 0;
  return (v / div).toLocaleString("en-US", {
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  });
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

function HighlightGrid({
  columns,
  rows,
  showHeader = true,
  scale,
  mobile,
}: {
  columns: HighlightColumn[];
  rows: HighlightRow[];
  showHeader?: boolean;
  scale: Scale;
  mobile: boolean;
}) {
  const emBg = "bg-[oklch(0.94_0.045_67)] dark:bg-[oklch(0.32_0.05_55)]";
  return (
    <table
      className={cn(
        "w-full table-fixed border-separate border-spacing-0",
        mobile ? "text-[13px]" : "min-w-[1040px] text-[15px]",
      )}
    >
      <colgroup>
        <col className={mobile ? "w-[38%]" : "w-[150px]"} />
        {columns.map((c) => (
          <col key={c.key} />
        ))}
      </colgroup>
      {showHeader && (
        <thead>
          <tr>
            <th className="bg-muted/50 sticky left-0 z-10 border-b px-2 py-2 text-left sm:px-3" />
            {columns.map((c) => (
              <th
                key={c.key}
                className={cn(
                  "text-muted-foreground border-b px-2 py-2 text-right font-medium whitespace-nowrap sm:px-3",
                  c.kind === "estimate" && "text-muted-foreground/70 italic",
                  c.kind === "ltm" && "bg-muted text-foreground",
                )}
              >
                <div>{c.label}</div>
                <div className="text-muted-foreground/60 text-[10px] font-normal sm:text-xs">
                  {c.date.replace(/-/g, "/").slice(2)}
                </div>
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {rows.map((r) => {
          if (r.spacer) {
            return (
              <tr key={r.key}>
                <td colSpan={columns.length + 1} className="h-2.5" />
              </tr>
            );
          }
          return (
            <tr
              key={r.key}
              className={cn(r.emphasis && "font-semibold", !r.indent && "hover:bg-muted/20")}
            >
              <td
                className={cn(
                  "sticky left-0 z-10 px-2 py-1.5 sm:px-3",
                  mobile ? "leading-tight" : "whitespace-nowrap",
                  r.emphasis ? `${emBg} border-t` : "bg-background",
                  r.indent
                    ? "text-muted-foreground/80 pl-4 text-[12px] sm:pl-6 sm:text-sm"
                    : "text-foreground/90",
                )}
              >
                {r.label}
              </td>
              {r.values.map((v, i) => (
                <td
                  key={i}
                  className={cn(
                    "tnum px-2 py-1.5 text-right whitespace-nowrap sm:px-3",
                    r.emphasis && `${emBg} border-t`,
                    r.indent && "text-muted-foreground/70 text-[12px] sm:text-[13px]",
                    columns[i]?.kind === "estimate" && "text-muted-foreground/60 italic",
                    columns[i]?.kind === "ltm" && !r.emphasis && "bg-muted/60",
                    v != null && v < 0 && !r.indent && "text-destructive",
                  )}
                >
                  {fmt(v, r.format, scale)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function FinancialHighlightsTable({ data }: { data: FinancialHighlights }) {
  const mobile = useIsMobile();
  const scale: Scale = mobile ? "billion" : "million";
  const unitLabel = mobile ? "USD 10억" : data.unitLabel;

  // 모바일: 전년(직전 FY) · 현재(LTM) · 차년(첫 추정) 3개 컬럼만
  let columns = data.columns;
  let rows = data.rows;
  let valuationRows = data.valuationRows;
  if (mobile) {
    const lastFy = data.columns.map((c, i) => (c.kind === "fy" ? i : -1)).filter((i) => i >= 0).pop();
    const ltm = data.columns.findIndex((c) => c.kind === "ltm");
    const est = data.columns.findIndex((c) => c.kind === "estimate");
    const pick = [lastFy, ltm, est].filter((i): i is number => i != null && i >= 0);
    const slice = <T extends { values: (number | null)[] }>(r: T) => ({
      ...r,
      values: pick.map((i) => r.values[i]),
    });
    columns = pick.map((i) => data.columns[i]);
    rows = data.rows.map(slice);
    valuationRows = valuationRows.map(slice);
  }

  const splitAt = rows.findIndex((r) => r.spacer);
  const evRows = splitAt >= 0 ? rows.slice(0, splitAt) : rows;
  const flowRows = splitAt >= 0 ? rows.slice(splitAt + 1) : [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">재무 하이라이트</h2>
        <span className="text-muted-foreground text-xs">
          단위: {unitLabel} · 12개월 결산 · 현재/LTM {data.asOfLtm}
        </span>
      </div>

      <div className={cn("rounded-lg border", !mobile && "overflow-x-auto")}>
        <HighlightGrid columns={columns} rows={evRows} scale={scale} mobile={mobile} />
        {flowRows.length > 0 && (
          <>
            <div className={cn("bg-muted/40 h-2", !mobile && "min-w-[1040px]")} />
            <HighlightGrid
              columns={columns}
              rows={flowRows}
              showHeader={false}
              scale={scale}
              mobile={mobile}
            />
          </>
        )}
      </div>

      {valuationRows.length > 0 && (
        <div className={cn("rounded-lg border", !mobile && "overflow-x-auto")}>
          <HighlightGrid
            columns={columns}
            rows={valuationRows}
            scale={scale}
            mobile={mobile}
          />
        </div>
      )}

      <ul className="text-muted-foreground/70 space-y-0.5 text-xs">
        {data.notes.map((n, i) => (
          <li key={i}>· {n}</li>
        ))}
      </ul>
    </section>
  );
}
