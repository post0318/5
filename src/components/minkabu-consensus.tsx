"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, TriangleAlert } from "lucide-react";
import { apiFetch } from "@/lib/query";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import type { MinkabuRating, MinkabuResult } from "@/lib/markets/jp/minkabu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChangePercent, Money, stockDirClass } from "@/components/num";

const RATINGS: MinkabuRating[] = ["強気買い", "買い", "中立", "売り", "強気売り"];
const RATING_KO: Record<MinkabuRating, string> = {
  強気買い: "적극 매수",
  買い: "매수",
  中立: "중립",
  売り: "매도",
  強気売り: "적극 매도",
};
/** 분포 막대 색 — 일본은 상승=녹색·하락=적색 관행 */
const RATING_BAR: Record<MinkabuRating, string> = {
  強気買い: "bg-up",
  買い: "bg-up/60",
  中立: "bg-muted-foreground/40",
  売り: "bg-down/60",
  強気売り: "bg-down",
};
const HISTORY_KO: Record<string, string> = { "3m": "3개월 전", "1m": "1개월 전", "1w": "1주 전", latest: "최신" };

function ratingClass(r: MinkabuRating | null): string {
  if (r === "強気買い" || r === "買い") return stockDirClass(true, "jp");
  if (r === "売り" || r === "強気売り") return stockDirClass(false, "jp");
  return "text-muted-foreground";
}

const pct = (now: number | null | undefined, then: number | null | undefined) =>
  now != null && then != null && then !== 0 ? ((now - then) / then) * 100 : null;

/**
 * 민카부 애널리스트 컨센서스(일본 종목 전용) — Yahoo 목표주가와 별개 출처로 나란히 보여 준다.
 * 실패·미커버는 카드 자체를 숨기거나 경고 한 줄만(페이지는 그대로).
 */
export function MinkabuConsensus({ symbol, price }: { symbol: string; price: number | null }) {
  const q = useQuery({
    queryKey: ["minkabu", symbol],
    queryFn: () => apiFetch<MinkabuResult>(`/api/markets/jp/${encodeURIComponent(symbol)}/minkabu`),
    enabled: Boolean(symbol),
    retry: false,
    staleTime: 60 * 60_000,
  });

  if (q.isLoading) return <Skeleton className="h-40 w-full" />;
  if (q.isError || !q.data || q.data.noCoverage) return null;
  const r = q.data;
  const link = (
    <a
      href={r.url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px] font-normal"
    >
      출처: {r.source} <ExternalLink className="size-3" />
    </a>
  );
  if (!r.data) {
    return r.warning ? (
      <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
        <TriangleAlert className="size-3" /> 민카부 컨센서스: {r.warning} · {link}
      </div>
    ) : null;
  }

  const d = r.data;
  const latest = d.history.find((h) => h.key === "latest")?.targetPrice ?? null;
  const ago = (k: "1m" | "3m") => d.history.find((h) => h.key === k)?.targetPrice ?? null;
  const upside = pct(d.targetPrice, price);

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-2 pb-2">
        <CardTitle className="text-sm">민카부 컨센서스</CardTitle>
        {link}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 text-sm lg:grid-cols-4">
          <div>
            <div className="text-muted-foreground text-xs">목표주가</div>
            <div className="inline-flex flex-wrap items-baseline gap-1.5 text-base font-semibold">
              <Money value={d.targetPrice} currency="JPY" />
              {upside != null && (
                <span className="text-sm font-normal">
                  (<ChangePercent value={upside} market="jp" />)
                </span>
              )}
            </div>
            <div className="text-muted-foreground mt-1 text-[11px]">
              1개월 전 대비 <ChangePercent value={pct(latest, ago("1m"))} market="jp" /> · 3개월 전 대비{" "}
              <ChangePercent value={pct(latest, ago("3m"))} market="jp" />
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">레이팅</div>
            <div className={cn("text-base font-semibold", ratingClass(d.rating))}>
              {RATING_KO[d.rating]} <span className="text-xs font-normal">({d.rating})</span>
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">애널리스트 수</div>
            <div className="tnum text-base font-semibold">{formatNumber(d.analystCount, 0)}명</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">기준일</div>
            <div className="tnum text-base">{d.asOf ?? "-"}</div>
          </div>
        </div>

        {/* 의견 분포 */}
        <div className="space-y-1.5">
          <div className="bg-muted flex h-2 w-full overflow-hidden rounded">
            {RATINGS.map((k) =>
              d.breakdown[k] > 0 ? (
                <div
                  key={k}
                  className={RATING_BAR[k]}
                  style={{ width: `${(d.breakdown[k] / d.analystCount) * 100}%` }}
                />
              ) : null,
            )}
          </div>
          <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {RATINGS.map((k) => (
              <span key={k} className="tnum">
                {RATING_KO[k]} <span className="text-foreground font-medium">{d.breakdown[k]}</span>
              </span>
            ))}
          </div>
        </div>

        {/* 변화(3개월 전 · 1개월 전 · 1주 전 · 최신) */}
        {d.history.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b">
                  <th className="py-1.5 text-left font-medium"></th>
                  {d.history.map((h) => (
                    <th key={h.key} className="py-1.5 text-right font-medium">
                      {HISTORY_KO[h.key]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="tnum">
                <tr className="border-b">
                  <td className="text-muted-foreground py-1.5">레이팅</td>
                  {d.history.map((h) => (
                    <td key={h.key} className={cn("py-1.5 text-right", ratingClass(h.rating))}>
                      {h.rating ? RATING_KO[h.rating] : "-"}
                    </td>
                  ))}
                </tr>
                <tr className="border-b">
                  <td className="text-muted-foreground py-1.5">목표주가</td>
                  {d.history.map((h) => (
                    <td key={h.key} className="py-1.5 text-right">
                      <Money value={h.targetPrice} currency="JPY" />
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* 실적 예상 변화(애널리스트 평균 vs 회사 예상) */}
        {d.estimates && (
          <div className="overflow-x-auto">
            <div className="text-muted-foreground mb-1 text-xs">
              {d.estimates.title} 실적 예상 (백만엔 · EPS 엔)
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b">
                  <th className="py-1.5 text-left font-medium"></th>
                  {d.estimates.columns.map((c, i) => (
                    <th key={i} className="py-1.5 text-right font-medium">
                      {c.source === "company" ? "회사 예상" : (HISTORY_KO[["3m", "1m", "1w", "latest"][i]] ?? c.label)}
                      <div className="text-[10px] font-normal">{c.date ?? ""}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="tnum">
                {d.estimates.rows.map((row) => (
                  <tr key={row.name} className="border-b">
                    <td className="text-muted-foreground py-1.5">
                      {row.name === "売上高" ? "매출액" : row.name === "当期利益" ? "순이익" : "EPS"}
                    </td>
                    {row.values.map((v, i) => (
                      <td key={i} className="py-1.5 text-right">
                        {v == null ? "-" : formatNumber(v, row.unit === "円" ? 2 : 0)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-muted-foreground/80 text-[11px]">
          목표주가 = 증권 애널리스트 평균(예상 시점부터 1년 뒤 주가) · 민카부 페이지를 종목당 12시간 캐시
        </p>
      </CardContent>
    </Card>
  );
}
