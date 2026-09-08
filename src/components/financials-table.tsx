"use client";

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import type { FinancialLineItem, FinancialStatement } from "@/lib/markets/types";

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

function fmtDetail(
  v: number,
  kind: FinancialLineItem["numberFormat"] | undefined,
  billion = false,
): string {
  if (kind === "eps" || kind === "pct") return formatNumber(v, 2);
  if (kind === "mult") return `${formatNumber(v, 2)}x`;
  if (kind === "shares") return formatNumber(v / (billion ? 1e9 : 1e6), billion ? 2 : 1);
  // 통화 → 데스크톱 백만(정수) / 모바일 10억(소수 2) — 개요와 통일
  return billion ? formatNumber(v / 1e9, 2) : formatNumber(v / 1e6, 0);
}

export function FinancialsTable({
  statement,
  detailedCf,
  detailedIs,
  detailedBs,
  detailedSummary,
  period,
  onPeriodChange,
  standalone,
}: {
  statement: FinancialStatement;
  /** 미국 표준화 상세 현금흐름표 */
  detailedCf?: FinancialStatement | null;
  /** 미국 표준화 상세 손익계산서 */
  detailedIs?: FinancialStatement | null;
  /** 미국 표준화 상세 재무상태표 */
  detailedBs?: FinancialStatement | null;
  /** 미국 공시기준 요약 (총괄 탭) */
  detailedSummary?: FinancialStatement | null;
  period?: "annual" | "quarter";
  onPeriodChange?: (p: "annual" | "quarter") => void;
  /** 이 statement 하나를 상세 스타일로만 렌더 (하위탭·토글 없음) */
  standalone?: boolean;
}) {
  const [view, setView] = useState<View>("all");

  const has = useMemo(() => {
    const s = new Set(statement.sections.map((x) => groupOf(x.title)));
    return {
      bs: s.has("bs") || Boolean(detailedBs),
      is: s.has("is") || Boolean(detailedIs),
      cf: s.has("cf") || Boolean(detailedCf),
    };
  }, [statement.sections, detailedCf, detailedIs, detailedBs]);

  const detail = standalone
    ? statement
    : view === "all" && detailedSummary
      ? detailedSummary
      : view === "cf" && detailedCf
        ? detailedCf
        : view === "is" && detailedIs
          ? detailedIs
          : view === "bs" && detailedBs
            ? detailedBs
            : null;
  const useDetail = detail != null;
  const mobile = useIsMobile();
  // 모바일 재무제표 탭: 현재 기준 최근 3기(현재+전년+전전년)만, 통화 10억 단위
  const mobileDetail = mobile && useDetail && !standalone;
  const allPeriods = useDetail ? detail.periods : statement.periods;
  const periods = mobileDetail ? allPeriods.slice(-3) : allPeriods;

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

      {!standalone && (
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
        {period && onPeriodChange && (
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
      )}

      <div className="space-y-6">
        {shown.map((section) => {
          const noteStart = section.items.findIndex(
            (i) => i.accountName === "[ 주석 항목 ]",
          );
          return (
          <div key={section.title} className="overflow-x-auto">
            <table
              className={cn(
                "w-full table-fixed border-separate border-spacing-0",
                mobileDetail ? "text-[13px]" : "text-sm",
              )}
              style={{
                minWidth: mobileDetail ? undefined : `${232 + periods.length * 96}px`,
              }}
            >
              <colgroup>
                <col style={{ width: mobileDetail ? "40%" : "232px" }} />
                {periods.map((p) => (
                  <col key={p.label} />
                ))}
              </colgroup>
              <thead>
                {useDetail && !standalone && (
                  <tr>
                    <th className="bg-background sticky left-0 z-10" />
                    <th
                      colSpan={periods.length}
                      className="text-muted-foreground px-3 pt-1 pb-0.5 text-right text-xs font-normal"
                    >
                      단위: {detail.unit || "USD"} {mobileDetail ? "10억" : "백만"}
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
                  const labelOnly =
                    item.isSubtotal &&
                    periods.every((p) => item.values[p.label] == null);
                  const emphasis = item.isHighlight;
                  // 총괄 요약: 모든 본문 짝수행 옅은 배경 / 주석 항목: EBITDA 행부터
                  const isSummary = detailedSummary != null && detail === detailedSummary;
                  const zebra = isSummary
                    ? idx % 2 === 1
                    : noteStart >= 0 &&
                      idx > noteStart &&
                      (idx - noteStart - 1) % 2 === 0;
                  return (
                    <tr
                      key={`${idx}-${item.accountId ?? item.accountName}`}
                      className={cn(
                        emphasis && (useDetail ? EM_BG : "bg-highlight-row"),
                        !emphasis && zebra && "bg-muted/40",
                        !emphasis && !zebra && item.isSubtotal && !labelOnly && "bg-muted/50",
                        item.isSubtotal && "font-semibold",
                        item.italic && "text-muted-foreground italic",
                      )}
                    >
                      <td
                        className={cn(
                          "sticky left-0 z-10 border-b px-3 py-1.5 leading-tight",
                          emphasis
                            ? useDetail
                              ? EM_BG
                              : "bg-highlight-row"
                            : zebra
                              ? "bg-muted/40"
                              : item.isSubtotal && !labelOnly
                                ? "bg-muted/50"
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
                              ltm &&
                                !emphasis &&
                                !labelOnly &&
                                "border-b-white/60 bg-foreground/10",
                            )}
                          >
                            {labelOnly
                              ? ""
                              : v == null
                                ? "-"
                                : item.paren
                                  ? `(${
                                      useDetail
                                        ? fmtDetail(v, item.numberFormat, mobileDetail)
                                        : formatNumber(v, perShare ? 2 : 0)
                                    })`
                                  : useDetail
                                    ? fmtDetail(v, item.numberFormat, mobileDetail)
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
          );
        })}
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
