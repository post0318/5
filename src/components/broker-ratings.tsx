"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { apiFetch } from "@/lib/query";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/format";
import type { MarketId } from "@/lib/markets/types";
import type { ConsensusData } from "@/lib/markets/consensus";
import type { AnalystRating } from "@/lib/markets/quote/yahoo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChangePercent, stockDirClass } from "@/components/num";

/** 개요에 노출할 최대 건수. 그 이상은 원본 사이트 링크로 넘긴다(오너 지시). */
const OVERVIEW_ROWS = 10;

/** /api/markets/us/[symbol]/analyst-forecasts 응답 1건 (StockAnalysis 수집분). */
interface AnalystForecast {
  date: string;
  analyst: string;
  analystSlug: string | null;
  firm: string;
  rating: string;
  ratingOld: string | null;
  action: string;
  priceTarget: number | null;
  priceTargetOld: number | null;
  currency: string;
  score: number | null;
  stars: number | null;
  successRate: number | null;
  analystRank: number | null;
  rankedExperts: number | null;
  totalRatings: number | null;
  stockSuccessRate: number | null;
  stockAvgReturn: number | null;
}

/** Yahoo 등급 문자열 → 매수/중립/매도 3분류. 증권사마다 표현이 달라 소문자 포함 검사. */
/** "Reiterated: Buy" 처럼 액션이 접두어로 붙어 오는 경우 등급만 남긴다. */
function cleanGrade(grade: string | null): string | null {
  if (!grade) return null;
  const i = grade.indexOf(":");
  const g = (i >= 0 ? grade.slice(i + 1) : grade).trim();
  return g || null;
}

function gradeTone(grade: string | null): "buy" | "hold" | "sell" | null {
  const cleaned = cleanGrade(grade);
  if (!cleaned) return null;
  const g = cleaned.toLowerCase();
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
    // reit(Reiterated)·main 둘 다 등급을 그대로 둔 것 → "유지"로 통일(오너 확인).
    case "reit":
    case "main":
      return { text: "유지", dir: 0 };
    default:
      return { text: action ?? "-", dir: 0 };
  }
}

/** StockAnalysis 의 영문 action → 화면 라벨. */
function saActionLabel(action: string): { text: string; dir: 1 | -1 | 0 } {
  const a = action.toLowerCase();
  if (a.includes("upgrade")) return { text: "상향", dir: 1 };
  if (a.includes("downgrade")) return { text: "하향", dir: -1 };
  if (a.includes("initiate")) return { text: "신규", dir: 0 };
  // Reiterates·Maintains 둘 다 등급 변경 없음 → "유지".
  if (a.includes("maintain") || a.includes("reiterate")) return { text: "유지", dir: 0 };
  return { text: action || "-", dir: 0 };
}

/** 목표주가 변경 방향. 직전 목표주가가 없으면 "변경 없음"으로 본다. */
function targetDir(now: number | null, prior: number | null): 1 | -1 | 0 {
  if (now == null || prior == null) return 0;
  if (now > prior) return 1;
  if (now < prior) return -1;
  return 0;
}

function GradeBadge({ grade }: { grade: string | null }) {
  const tone = gradeTone(grade);
  const label = cleanGrade(grade);
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-xs font-medium",
        tone === "buy" && "bg-up/10 text-up",
        tone === "sell" && "bg-down/10 text-down",
        tone === "hold" && "text-muted-foreground bg-muted",
      )}
    >
      {label || "-"}
    </span>
  );
}

/**
 * 적중률(0~100%)을 막대+숫자로. StockAnalysis 의 score 는 success_rate 와 같은
 * 값이라(실측: 56/56, 56.1/56.1 …) 두 열을 따로 두지 않고 이 하나로 쓴다.
 * 70 이상 녹색 · 50~70 황색 · 그 미만 회색.
 */
function ScoreBar({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">-</span>;
  const pct = Math.max(0, Math.min(100, value));
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="bg-muted h-1.5 w-10 shrink-0 overflow-hidden rounded-full">
        <span
          className={cn(
            "block h-full rounded-full",
            pct >= 70 ? "bg-up" : pct >= 50 ? "bg-amber-400" : "bg-muted-foreground/50",
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="tnum">{formatNumber(value, 0)}%</span>
    </span>
  );
}

function Pct({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">-</span>;
  return <span className="tnum">{formatNumber(value, 0)}%</span>;
}

/**
 * 수익률 — 소수점 1자리(오너 지시). 공용 ChangePercent 는 formatPercent 가
 * 2자리 고정이라 전역을 건드리지 않으려고 여기서만 따로 그린다.
 */
function ReturnPct({ value, market }: { value: number | null; market: MarketId }) {
  if (value == null) return <span className="text-muted-foreground">-</span>;
  return (
    <span
      className={cn(
        "tnum",
        value > 0 && stockDirClass(true, market),
        value < 0 && stockDirClass(false, market),
        value === 0 && "text-muted-foreground",
      )}
    >
      {value > 0 ? "+" : ""}
      {formatNumber(value, 1)}%
    </span>
  );
}

/** 순위 — 등수만. 모집단(전체 애널리스트 수)은 표 하단 주석에 한 번만 쓴다. */
function Rank({ rank }: { rank: number | null }) {
  if (rank == null) return <span className="text-muted-foreground">-</span>;
  return <span className="tnum whitespace-nowrap">{formatNumber(rank, 0)}</span>;
}

function SourceLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px] font-normal"
    >
      {label}
      <ExternalLink className="size-3" />
    </a>
  );
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

  // 개별 애널리스트 의견(StockAnalysis 수집분, 종목당 최대 8건). 미수집 종목이면
  // 빈 배열이 와서 Yahoo 증권사 단위 표로 폴백한다.
  const saq = useQuery({
    queryKey: ["analyst-forecasts", market, symbol],
    queryFn: () =>
      apiFetch<{ items: AnalystForecast[] }>(
        `/api/markets/${market}/${encodeURIComponent(symbol)}/analyst-forecasts`,
      ),
    enabled: Boolean(symbol),
    retry: false,
    staleTime: 30 * 60_000,
  });

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (q.isError) return null; // 컨센서스 카드에서 이미 에러를 안내한다.

  const d = q.data;
  const ratings = d?.analystRatings ?? [];
  const forecasts = saq.data?.items ?? [];
  if (ratings.length === 0 && forecasts.length === 0) return null;

  const price = d?.price ?? null;
  const currency = d?.currency ?? "USD";
  const money = (v: number | null) => (v == null ? "-" : formatCurrency(v, currency));
  const upside = (t: number | null) =>
    t != null && price != null && price !== 0 ? ((t - price) / price) * 100 : null;

  const changes = ratings.slice(0, OVERVIEW_ROWS);
  // StockAnalysis 수집분이 없을 때만 Yahoo 로 "최근 투자의견"을 만든다
  // (목표주가를 제시한 건만 — Price Target 열이 이 표의 핵심).
  const yahooLatest = ratings.filter((r) => r.priceTarget != null).slice(0, OVERVIEW_ROWS);
  // 전체 애널리스트 수는 StockAnalysis 쪽에서 계속 늘어나므로 하드코딩하지 않고
  // 수집분에서 읽어 주석에 쓴다.
  const rankedExperts = forecasts.find((f) => f.rankedExperts != null)?.rankedExperts ?? null;

  const yahooUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(yahoo || symbol)}/analysis`;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">종목 투자의견</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 최근 투자의견 — 애널리스트 개인 단위(StockAnalysis 수집분, 최대 8건) */}
        {forecasts.length > 0 ? (
          <div>
            <div className="overflow-x-auto">
              <table className="w-full table-fixed text-xs">
                <colgroup>
                  {/* 애널리스트는 줄이고 증권사는 이름이 한 줄에 들어가게 넓힌다
                      (오너 지시 — "Bank of America Securities" 기준).
                      나머지 9개 수치 열은 같은 폭. 모바일에서는 증권사·적중률·
                      순위·현종목적중률·현종목수익률 열을 숨긴다(오너 지시) —
                      <col> 자체도 숨겨야 그 만큼의 폭이 빈 공간으로 안 남는다. */}
                  <col style={{ width: "18%" }} />
                  <col className="hidden sm:table-column" style={{ width: "13%" }} />
                  <col className="hidden sm:table-column" style={{ width: "7.78%" }} />
                  <col className="hidden sm:table-column" style={{ width: "7.78%" }} />
                  <col style={{ width: "7.78%" }} />
                  <col style={{ width: "7.78%" }} />
                  <col style={{ width: "7.78%" }} />
                  <col style={{ width: "7.78%" }} />
                  <col className="hidden sm:table-column" style={{ width: "7.78%" }} />
                  <col className="hidden sm:table-column" style={{ width: "7.78%" }} />
                  <col style={{ width: "7.78%" }} />
                </colgroup>
                <thead>
                  <tr className="text-muted-foreground border-b">
                    <th className="py-1.5 text-left align-bottom font-medium">애널리스트</th>
                    <th className="hidden py-1.5 text-left align-bottom font-medium sm:table-cell">
                      증권사
                    </th>
                    <th className="hidden py-1.5 text-center align-bottom font-medium sm:table-cell">
                      적중률
                    </th>
                    <th className="hidden py-1.5 text-center align-bottom font-medium sm:table-cell">
                      순위
                    </th>
                    <th className="py-1.5 text-center align-bottom font-medium">투자의견</th>
                    <th className="py-1.5 text-center align-bottom font-medium">등급조정</th>
                    <th className="py-1.5 text-center align-bottom font-medium">목표주가</th>
                    <th className="py-1.5 text-center align-bottom font-medium">상승여력</th>
                    <th className="hidden py-1.5 text-center align-bottom font-medium sm:table-cell">
                      현종목
                      <br />
                      적중률
                    </th>
                    <th className="hidden py-1.5 text-center align-bottom font-medium sm:table-cell">
                      현종목
                      <br />
                      수익률
                    </th>
                    <th className="py-1.5 text-center align-bottom font-medium">
                      최근
                      <br />
                      변경일자
                    </th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {forecasts.map((f, i) => {
                    const act = saActionLabel(f.action);
                    const tdir = targetDir(f.priceTarget, f.priceTargetOld);
                    return (
                      <tr
                        key={`${f.date}-${f.analystSlug ?? f.firm}`}
                        className={cn("border-b", i % 2 === 1 && "bg-muted/40")}
                      >
                        <td className="py-1.5 pr-3 text-left">
                          <div className="flex items-baseline gap-1.5">
                            {f.analystSlug ? (
                              <a
                                href={`https://stockanalysis.com/analysts/${f.analystSlug}/`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-medium whitespace-nowrap hover:underline"
                              >
                                {f.analyst || "-"}
                              </a>
                            ) : (
                              <span className="font-medium whitespace-nowrap">{f.analyst || "-"}</span>
                            )}
                            {f.stars != null && (
                              <span className="text-muted-foreground text-[11px] whitespace-nowrap">
                                ★ {f.stars.toFixed(1)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="text-muted-foreground hidden py-1.5 pr-3 text-left whitespace-nowrap sm:table-cell">
                          {f.firm}
                        </td>
                        <td className="hidden py-1.5 pr-3 pl-3 text-center sm:table-cell">
                          <ScoreBar value={f.score ?? f.successRate} />
                        </td>
                        <td className="hidden py-1.5 text-right sm:table-cell">
                          <Rank rank={f.analystRank} />
                        </td>
                        <td className="py-1.5 pr-3 pl-3 text-center">
                          <GradeBadge grade={f.rating} />
                        </td>
                        <td
                          className={cn(
                            "py-1.5 pr-3 text-center text-xs",
                            act.dir === 1 && stockDirClass(true, market),
                            act.dir === -1 && stockDirClass(false, market),
                            act.dir === 0 && "text-muted-foreground",
                          )}
                        >
                          {act.text}
                        </td>
                        <td className="py-1.5 text-right">
                          {tdir !== 0 && (
                            <span className="text-muted-foreground mr-1 text-xs">
                              {money(f.priceTargetOld)} →
                            </span>
                          )}
                          <span
                            className={cn(
                              "font-medium",
                              tdir === 1 && stockDirClass(true, market),
                              tdir === -1 && stockDirClass(false, market),
                            )}
                          >
                            {money(f.priceTarget)}
                          </span>
                        </td>
                        <td className="py-1.5 text-right">
                          <ChangePercent value={upside(f.priceTarget)} market={market} />
                        </td>
                        <td className="hidden py-1.5 pl-3 text-right sm:table-cell">
                          <Pct value={f.stockSuccessRate} />
                        </td>
                        <td className="hidden py-1.5 pr-3 text-right sm:table-cell">
                          <ReturnPct value={f.stockAvgReturn} market={market} />
                        </td>
                        <td className="text-muted-foreground py-1.5 text-right whitespace-nowrap">
                          {f.date}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-muted-foreground/70 mt-1.5 text-[11px]">
              적중률·순위는 애널리스트의 모든 종목 예측 기준 · 현종목 = 이 종목에 한정한 실적 ·
              순위는 전체 애널리스트{" "}
              {rankedExperts != null && `${formatNumber(rankedExperts, 0)}명 `}중 등수
              (StockAnalysis 산출)
            </p>
          </div>
        ) : (
          yahooLatest.length > 0 && (
            <div>
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h4 className="text-xs font-semibold">최근 투자의견</h4>
                <SourceLink href={yahooUrl} label="전체 보기" />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                  <tr className="text-muted-foreground border-b">
                    <th className="py-1.5 text-left align-bottom font-medium">증권사</th>
                    <th className="py-1.5 text-center align-bottom font-medium">투자의견</th>
                    <th className="py-1.5 text-center align-bottom font-medium">등급조정</th>
                    <th className="py-1.5 text-right align-bottom font-medium">목표주가</th>
                    <th className="py-1.5 text-right align-bottom font-medium">상승여력</th>
                    <th className="py-1.5 text-right align-bottom font-medium">일자</th>
                  </tr>
                </thead>
                  <tbody className="tnum">
                    {yahooLatest.map((r: AnalystRating, i) => {
                      const act = actionLabel(r.action);
                      const tdir = targetDir(r.priceTarget, r.priorPriceTarget);
                      return (
                        <tr
                          key={`${r.date}-${r.firm}-${i}`}
                          className={cn("border-b", i % 2 === 1 && "bg-muted/40")}
                        >
                          <td className="py-1.5 pr-3 text-left font-medium">{r.firm}</td>
                          <td className="py-1.5 pr-3 text-center">
                            <GradeBadge grade={r.grade} />
                          </td>
                          <td
                            className={cn(
                              "py-1.5 pr-3 text-center text-xs",
                              act.dir === 1 && stockDirClass(true, market),
                              act.dir === -1 && stockDirClass(false, market),
                              act.dir === 0 && "text-muted-foreground",
                            )}
                          >
                            {act.text}
                          </td>
                          <td className="py-1.5 text-right whitespace-nowrap">
                            {tdir !== 0 && (
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
          )
        )}

        {/* 투자의견 변경 이력 (증권사 단위, Yahoo) */}
        {changes.length > 0 && (
          <div>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h4 className="text-xs font-semibold">
                투자의견 변경
                <span className="text-muted-foreground ml-2 font-normal">
                  최근 {changes.length}건
                </span>
              </h4>
              <SourceLink href={yahooUrl} label="전체 보기" />
            </div>
            <table className="w-full text-sm">
              <tbody>
                {changes.map((r, i) => {
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
                            : {cleanGrade(r.fromGrade) ?? "-"} →{" "}
                            {/* 색은 바뀐 결과 등급에만 — 하향이면 그 등급이 빨강,
                                상향이면 녹색. 유지는 회색 그대로(오너 지시). */}
                            <span
                              className={cn(
                                act.dir === 1 && stockDirClass(true, market),
                                act.dir === -1 && stockDirClass(false, market),
                                act.dir !== 0 && "font-medium",
                              )}
                            >
                              {cleanGrade(r.grade) ?? "-"}
                            </span>
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
        )}

        <p className="text-muted-foreground/70 text-[11px]">
          출처: {forecasts.length > 0 ? "StockAnalysis.com · Yahoo Finance" : "Yahoo Finance"}
        </p>
      </CardContent>
    </Card>
  );
}
