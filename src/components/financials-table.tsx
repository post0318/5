"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import type { FinancialLineItem, FinancialStatement } from "@/lib/markets/types";

type View = "all" | "bs" | "is" | "cf";

const GROUP: Record<string, Exclude<View, "all">> = {
  재무상태표: "bs",
  대차대조표: "bs",
  손익계산서: "is",
  포괄손익계산서: "is",
  현금흐름표: "cf",
};
const groupOf = (title: string): Exclude<View, "all"> | "other" =>
  GROUP[title] ?? "other";

const EM_BG = "bg-[oklch(0.94_0.045_67)] dark:bg-[oklch(0.32_0.05_55)]";

function fmtDetail(v: number, kind?: FinancialLineItem["numberFormat"]): string {
  if (kind === "eps" || kind === "pct") return formatNumber(v, 2);
  if (kind === "shares") return formatNumber(v / 1e6, 1); // 백만주, 소수 1
  return formatNumber(v / 1e6, 0); // 통화 → 백만, 정수
}

export function FinancialsTable({
  statement,
  detailedCf,
  detailedIs,
  period,
  onPeriodChange,
}: {
  statement: FinancialStatement;
  /** 미국 표준화 상세 현금흐름표 */
  detailedCf?: FinancialStatement | null;
  /** 미국 표준화 상세 손익계산서 */
  detailedIs?: FinancialStatement | null;
  period?: "annual" | "quarter";
  onPeriodChange?: (p: "annual" | "quarter") => void;
}) {
  const [view, setView] = useState<View>("all");

  const has = useMemo(() => {
    const s = new Set(statement.sections.map((x) => groupOf(x.title)));
    return {
      bs: s.has("bs"),
      is: s.has("is") || Boolean(detailedIs),
      cf: s.has("cf") || Boolean(detailedCf),
    };
  }, [statement.sections, detailedCf, detailedIs]);

  const detail =
    view === "cf" && detailedCf ? detailedCf : view === "is" && detailedIs ? detailedIs : null;
  const useDetail = detail != null;
  const periods = useDetail ? detail.periods : statement.periods;

  const tabs: { key: View; label: string }[] = [
    { key: "all", label: "총괄" },
    ...(has.bs ? [{ key: "bs" as View, label: "BS" }] : []),
    ...(has.is ? [{ key: "is" as View, label: "IS" }] : []),
    ...(has.cf ? [{ key: "cf" as View, label: "CF" }] : []),
  ];

  const shown = useDetail
    ? detail.sections
    : view === "all"
      ? statement.sections
      : statement.sections.filter((s) => groupOf(s.title) === view);

  return (
    <div className="space-y-3">
      {!useDetail && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span>단위: {statement.unit || "원본"}</span>
          <span>
            {statement.consolidation === "consolidated"
              ? "연결"
              : statement.consolidation === "separate"
                ? "별도"
                : "구분 미상"}
          </span>
          <span>출처: {statement.source}</span>
          {statement.sourceUrl && (
            <a
              href={statement.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              원문
            </a>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {tabs.length > 1 && (
          <div className="border-border flex overflow-hidden rounded-md border text-sm">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setView(t.key)}
                className={cn(
                  "px-3 py-1 transition-colors",
                  view === t.key
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted text-muted-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        {period && onPeriodChange && !useDetail && (
          <div className="border-border flex overflow-hidden rounded-md border text-sm">
            {(["annual", "quarter"] as const).map((p) => (
              <button
                key={p}
                onClick={() => onPeriodChange(p)}
                className={cn(
                  "px-3 py-1 transition-colors",
                  period === p
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted text-muted-foreground",
                )}
              >
                {p === "annual" ? "연간" : "분기"}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-6">
        {shown.map((section) => (
          <div key={section.title} className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
              <thead>
                {useDetail && (
                  <tr>
                    <th className="bg-background sticky left-0 z-10" />
                    <th
                      colSpan={periods.length}
                      className="text-muted-foreground px-3 pt-1 pb-0.5 text-right text-xs font-normal"
                    >
                      단위: {detail.unit || "USD"} 백만 (EPS·비율 제외)
                    </th>
                  </tr>
                )}
                <tr className={cn(useDetail && "bg-muted")}>
                  <th
                    className={cn(
                      "sticky left-0 z-10 border-b px-3 py-2 text-left font-medium",
                      useDetail
                        ? "text-foreground bg-muted"
                        : "text-muted-foreground bg-muted/50",
                    )}
                  >
                    {section.title}
                  </th>
                  {periods.map((p) => {
                    const ltm = p.label === "현재/LTM";
                    return (
                      <th
                        key={p.label}
                        className={cn(
                          "border-b px-3 py-2 text-right font-medium whitespace-nowrap",
                          useDetail ? "text-foreground" : "text-muted-foreground",
                          ltm && "bg-foreground/10",
                        )}
                      >
                        <div>{p.label}</div>
                        {useDetail && p.endDate && (
                          <div className="text-muted-foreground/60 text-[10px] font-normal">
                            {p.endDate.replace(/-/g, "/").slice(2)}
                          </div>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {section.items.map((item, idx) => {
                  if (!item.accountName) {
                    return (
                      <tr key={`sp${idx}`}>
                        <td colSpan={periods.length + 1} className="h-3" />
                      </tr>
                    );
                  }
                  const perShare =
                    /PerShare/i.test(item.accountId ?? "") ||
                    /주당|1株当たり|per share/i.test(item.accountName);
                  const emphasis = item.isHighlight;
                  return (
                    <tr
                      key={item.accountId ?? item.accountName}
                      className={cn(
                        emphasis && (useDetail ? EM_BG : "bg-highlight-row"),
                        item.isSubtotal && "font-semibold",
                      )}
                    >
                      <td
                        className={cn(
                          "sticky left-0 z-10 border-b px-3 py-1.5 whitespace-nowrap",
                          emphasis
                            ? useDetail
                              ? EM_BG
                              : "bg-highlight-row"
                            : "bg-background",
                        )}
                        style={{ paddingLeft: `${0.75 + item.depth * 0.85}rem` }}
                      >
                        {item.accountName}
                      </td>
                      {periods.map((p) => {
                        const v = item.values[p.label];
                        const neg = typeof v === "number" && v < 0;
                        const ltm = p.label === "현재/LTM";
                        return (
                          <td
                            key={p.label}
                            className={cn(
                              "tnum border-b px-3 py-1.5 text-right whitespace-nowrap",
                              neg && "text-down",
                              v == null && "text-muted-foreground",
                              ltm && !emphasis && "bg-foreground/10",
                            )}
                          >
                            {v == null
                              ? "-"
                              : useDetail
                                ? fmtDetail(v, item.numberFormat)
                                : formatNumber(v, perShare ? 2 : 0)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
        {shown.length === 0 && (
          <p className="text-muted-foreground text-sm">해당 재무제표가 없습니다.</p>
        )}
      </div>

      {useDetail && (
        <p className="text-muted-foreground/80 text-[11px]">출처: {detail.source}</p>
      )}
    </div>
  );
}
