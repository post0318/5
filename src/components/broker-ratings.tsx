"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/query";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import type { MarketId } from "@/lib/markets/types";
import type { ConsensusData } from "@/lib/markets/consensus";
import type { AnalystRating } from "@/lib/markets/quote/yahoo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChangePercent, stockDirClass } from "@/components/num";

const PAGE = 10;

/** Yahoo 등급 문자열 → 매수/중립/매도 3분류. 증권사마다 표현이 달라 소문자 포함 검사. */
function gradeTone(grade: string | null): "buy" | "hold" | "sell" | null {
  if (!grade) return null;
  const g = grade.toLowerCase();
  if (/(strong buy|conviction buy|^buy|outperform|overweight|accumulate|^add|positive|long-term buy)/.test(g))
    return "buy";
  if (/(strong sell|^sell|underperform|underweight|reduce|negative)/.test(g)) return "sell";
  return "hold";
}

/** Yahoo action 코드 → 화면 라벨. */
function actionLabel(action: string | null): { text: string; dir: 1 | -1 | 0 } {
  switch (action) {
    case "up":
      return { text: "상향", dir: 1 };
    case "down":
      return { text: "하향", dir: -1 };
    case "init":
      return { text: "신규", dir: 0 };
    case "reit":
      return { text: "재확인", dir: 0 };
    case "main":
      return { text: "유지", dir: 0 };
    default:
      return { text: action ?? "-", dir: 0 };
  }
}

/** 목표주가 변경 방향. Yahoo priceTargetAction 이 비어도 prior/current 로 판정. */
function targetDir(r: AnalystRating): 1 | -1 | 0 {
  if (r.priceTarget == null || r.priorPriceTarget == null) return 0;
  if (r.priceTarget > r.priorPriceTarget) return 1;
  if (r.priceTarget < r.priorPriceTarget) return -1;
  return 0;
}

export function BrokerRatings({
  market,
  symbol,
  yahoo,
}: {
  market: MarketId;
  symbol: string;
  yahoo?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  // ConsensusPanel 과 동일한 queryKey → 캐시를 공유하므로 추가 요청이 없다.
  const q = useQuery({
    queryKey: ["consensus", market, symbol, yahoo],
    queryFn: () =>
      apiFetch<ConsensusData>(
        `/api/markets/${market}/${encodeURIComponent(symbol)}/consensus` +
          (yahoo ? `?yahoo=${encodeURIComponent(yahoo)}` : ""),
      ),
    enabled: Boolean(symbol),
    retry: false,
    staleTime: 30 * 60_000,
  });

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (q.isError) return null; // 컨센서스 카드에서 이미 에러를 안내한다.

  const d = q.data;
  const ratings = d?.analystRatings ?? [];
  if (ratings.length === 0) return null;

  const price = d?.price ?? null;
  const currency = d?.currency ?? "USD";
  const money = (v: number | null) => (v == null ? "-" : formatCurrency(v, currency));
  const upside = (t: number | null) =>
    t != null && price != null && price !== 0 ? ((t - price) / price) * 100 : null;

  const shown = expanded ? ratings.slice(0, 50) : ratings.slice(0, PAGE);
  // 목표주가를 제시한 건만 "최근 투자의견" 표에 올린다 (Price Target 열이 핵심).
  const withTarget = shown.filter((r) => r.priceTarget != null);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          브로커 투자의견
          <span className="text-muted-foreground ml-2 text-xs font-normal">
            최근 {ratings.length.toLocaleString()}건 중 {shown.length}건 표시
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 최근 투자의견 — 목표주가·상승여력 포함 */}
        {withTarget.length > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-semibold">최근 투자의견</h4>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="text-muted-foreground border-b">
                    <th className="py-1.5 text-left font-medium">증권사</th>
                    <th className="py-1.5 text-left font-medium">투자의견</th>
                    <th className="py-1.5 text-left font-medium">액션</th>
                    <th className="py-1.5 text-right font-medium">목표주가</th>
                    <th className="py-1.5 text-right font-medium">상승여력</th>
                    <th className="py-1.5 text-right font-medium">일자</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {withTarget.map((r, i) => {
                    const tone = gradeTone(r.grade);
                    const act = actionLabel(r.action);
                    const tdir = targetDir(r);
                    return (
                      <tr
                        key={`${r.date}-${r.firm}-${i}`}
                        className={cn("border-b", i % 2 === 1 && "bg-muted/40")}
                      >
                        <td className="py-1.5 pr-3 text-left font-medium">{r.firm}</td>
                        <td className="py-1.5 pr-3 text-left">
                          <span
                            className={cn(
                              "rounded-md px-1.5 py-0.5 text-xs font-medium",
                              tone === "buy" && "bg-up/10 text-up",
                              tone === "sell" && "bg-down/10 text-down",
                              tone === "hold" && "text-muted-foreground bg-muted",
                            )}
                          >
                            {r.grade ?? "-"}
                          </span>
                        </td>
                        <td
                          className={cn(
                            "py-1.5 pr-3 text-left text-xs",
                            act.dir === 1 && stockDirClass(true, market),
                            act.dir === -1 && stockDirClass(false, market),
                            act.dir === 0 && "text-muted-foreground",
                          )}
                        >
                          {act.text}
                        </td>
                        <td className="py-1.5 text-right whitespace-nowrap">
                          {r.priorPriceTarget != null && tdir !== 0 && (
                            <span className="text-muted-foreground mr-1 text-xs">
                              {money(r.priorPriceTarget)} →
                            </span>
                          )}
                          <span
                            className={cn(
                              "font-medium",
                              tdir === 1 && stockDirClass(true, market),
                              tdir === -1 && stockDirClass(false, market),
                            )}
                          >
                            {money(r.priceTarget)}
                          </span>
                        </td>
                        <td className="py-1.5 text-right">
                          <ChangePercent value={upside(r.priceTarget)} market={market} />
                        </td>
                        <td className="text-muted-foreground py-1.5 text-right whitespace-nowrap">
                          {r.date}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 투자의견 변경 이력 */}
        <div>
          <h4 className="mb-2 text-xs font-semibold">투자의견 변경</h4>
          <table className="w-full text-sm">
            <tbody>
              {shown.map((r, i) => {
                const act = actionLabel(r.action);
                return (
                  <tr
                    key={`ud-${r.date}-${r.firm}-${i}`}
                    className={cn("border-b", i % 2 === 1 && "bg-muted/40")}
                  >
                    <td
                      className={cn(
                        "w-20 py-1.5 pl-2 text-left text-xs font-medium whitespace-nowrap",
                        act.dir === 1 && stockDirClass(true, market),
                        act.dir === -1 && stockDirClass(false, market),
                        act.dir === 0 && "text-muted-foreground",
                      )}
                    >
                      {act.text}
                    </td>
                    <td className="py-1.5 text-left">
                      <span className="font-medium">{r.firm}</span>
                      {(r.fromGrade || r.grade) && (
                        <span className="text-muted-foreground">
                          : {r.fromGrade ?? "-"} → {r.grade ?? "-"}
                        </span>
                      )}
                    </td>
                    <td className="text-muted-foreground tnum py-1.5 pr-2 text-right whitespace-nowrap">
                      {r.date}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {ratings.length > PAGE && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4"
          >
            {expanded ? "접기" : `더 보기 (최근 ${Math.min(ratings.length, 50)}건)`}
          </button>
        )}

        <p className="text-muted-foreground/70 text-[11px]">
          출처: Yahoo Finance — 애널리스트 개인명·정확도는 제공되지 않아 증권사 단위로만 표시
        </p>
      </CardContent>
    </Card>
  );
}
