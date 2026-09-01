"use client";

import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import type { FinancialStatement } from "@/lib/markets/types";

export function FinancialsTable({ statement }: { statement: FinancialStatement }) {
  const periods = statement.periods;

  return (
    <div className="space-y-6">
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

      {statement.sections.map((section) => (
        <div key={section.title} className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th className="bg-muted/50 text-muted-foreground sticky left-0 z-10 border-b px-3 py-2 text-left font-medium">
                  {section.title}
                </th>
                {periods.map((p) => (
                  <th
                    key={p.label}
                    className="text-muted-foreground border-b px-3 py-2 text-right font-medium whitespace-nowrap"
                  >
                    {p.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.items.map((item) => (
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
                        {v == null ? "-" : formatNumber(v, 0)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
