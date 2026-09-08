"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import type { FinancialStatement } from "@/lib/markets/types";

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

export function FinancialsTable({
  statement,
  detailedCf,
}: {
  statement: FinancialStatement;
  /** 미국 표준화 상세 현금흐름표 (CF 탭에서 총괄 대신 표시) */
  detailedCf?: FinancialStatement | null;
}) {
  const [view, setView] = useState<View>("all");

  const has = useMemo(() => {
    const s = new Set(statement.sections.map((x) => groupOf(x.title)));
    return { bs: s.has("bs"), is: s.has("is"), cf: s.has("cf") || Boolean(detailedCf) };
  }, [statement.sections, detailedCf]);

  const useCfDetail = view === "cf" && detailedCf != null;
  const periods = useCfDetail ? detailedCf!.periods : statement.periods;

  const tabs: { key: View; label: string }[] = [
    { key: "all", label: "총괄" },
    ...(has.bs ? [{ key: "bs" as View, label: "BS" }] : []),
    ...(has.is ? [{ key: "is" as View, label: "IS" }] : []),
    ...(has.cf ? [{ key: "cf" as View, label: "CF" }] : []),
  ];

  const shown = useCfDetail
    ? detailedCf!.sections
    : view === "all"
      ? statement.sections
      : statement.sections.filter((s) => groupOf(s.title) === view);

  const meta = useCfDetail ? detailedCf! : statement;
  return (
    <div className="space-y-4">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span>단위: {meta.unit || "원본"}{useCfDetail ? " (백만)" : ""}</span>
        <span>
          {meta.consolidation === "consolidated"
            ? "연결"
            : meta.consolidation === "separate"
              ? "별도"
              : "구분 미상"}
        </span>
        <span>출처: {meta.source}</span>
        {meta.sourceUrl && (
          <a
            href={meta.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            원문
          </a>
        )}
      </div>

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

      <div className="space-y-6">
        {shown.map((section) => (
          <div key={section.title} className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
              <thead>
                <tr className={cn(useCfDetail && "bg-muted")}>
                  <th
                    className={cn(
                      "sticky left-0 z-10 border-b px-3 py-2 text-left font-medium",
                      useCfDetail
                        ? "text-foreground bg-muted"
                        : "text-muted-foreground bg-muted/50",
                    )}
                  >
                    {section.title}
                  </th>
                  {periods.map((p) => (
                    <th
                      key={p.label}
                      className={cn(
                        "border-b px-3 py-2 text-right font-medium whitespace-nowrap",
                        useCfDetail ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {p.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.items.map((item) => {
                  const perShare =
                    /PerShare/i.test(item.accountId ?? "") ||
                    /주당|1株当たり|per share/i.test(item.accountName);
                  return (
                  <tr
                    key={item.accountId ?? item.accountName}
                    className={cn(
                      item.isHighlight && "bg-highlight-row",
                      item.isSubtotal && "font-semibold",
                    )}
                  >
                    <td
                      className={cn(
                        "bg-background sticky left-0 z-10 border-b px-3 py-1.5 whitespace-nowrap",
                        item.isHighlight && "bg-highlight-row",
                      )}
                      style={{ paddingLeft: `${0.75 + item.depth * 0.85}rem` }}
                    >
                      {item.accountName}
                    </td>
                    {periods.map((p) => {
                      const v = item.values[p.label];
                      const neg = typeof v === "number" && v < 0;
                      return (
                        <td
                          key={p.label}
                          className={cn(
                            "tnum border-b px-3 py-1.5 text-right whitespace-nowrap",
                            neg && "text-down",
                            v == null && "text-muted-foreground",
                          )}
                        >
                          {v == null
                            ? "-"
                            : useCfDetail
                              ? formatNumber(v / 1e6, 1)
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
    </div>
  );
}
