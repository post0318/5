"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiFetch } from "@/lib/query";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import type { MarketId } from "@/lib/markets/types";
import type { ConsensusData } from "@/lib/markets/consensus";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DeepLinkList } from "@/components/deep-links";

export function ConsensusPanel({
  market,
  symbol,
  yahoo,
}: {
  market: MarketId;
  symbol: string;
  yahoo?: string | null;
}) {
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

  if (q.isLoading) return <Skeleton className="h-72 w-full" />;
  if (q.isError)
    return (
      <p className="text-muted-foreground text-sm">
        컨센서스를 불러오지 못했습니다 — {(q.error as Error).message}
      </p>
    );
  const d = q.data;
  if (!d || d.rows.length === 0)
    return <p className="text-muted-foreground text-sm">표시할 컨센서스 데이터가 없습니다.</p>;

  const bigUnit = market === "jp" ? "천만엔" : market === "us" ? "백만$" : "억원";
  const won = (v: number | null) => (v == null ? "-" : formatNumber(v, market === "kr" ? 0 : 2));
  const mult = (v: number | null) => (v == null ? "-" : `${formatNumber(v, 2)}x`);
  const pct = (v: number | null) => (v == null ? "-" : `${v > 0 ? "+" : ""}${formatNumber(v, 2)}%`);

  const chartData = d.rows.map((r) => ({
    label: r.label,
    revenue: r.revenue != null ? r.revenue / (market === "kr" ? 1e8 : market === "jp" ? 1e7 : 1e6) : null,
    eps: r.eps,
    est: r.isEstimate,
  }));

  const recTxt =
    d.recommendationMean == null
      ? null
      : d.recommendationMean <= 2
        ? "매수 우위"
        : d.recommendationMean <= 3
          ? "중립"
          : "매도 우위";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          컨센서스
          <span className="text-muted-foreground text-xs font-normal">
            실적: 공시 재무제표 · 추정: yahoo 개인용
          </span>
          {d.targetPrice != null && (
            <span className="text-muted-foreground ml-auto text-xs font-normal">
              목표주가 {won(d.targetPrice)} · 투자의견{" "}
              {d.recommendationMean != null ? `${formatNumber(d.recommendationMean, 2)} (${recTxt})` : "-"}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 매출·EPS 추이 차트 */}
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis
                yAxisId="rev"
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={68}
                tickFormatter={(v: number) => formatNumber(v, 0)}
              />
              <YAxis
                yAxisId="eps"
                orientation="right"
                tick={{ fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={60}
                tickFormatter={(v: number) => formatNumber(v, 0)}
              />
              <Tooltip
                contentStyle={{ fontSize: 12 }}
                formatter={(value) => formatNumber(Number(value), 0)}
              />
              <Legend verticalAlign="top" height={28} wrapperStyle={{ fontSize: 11 }} />
              <Bar
                yAxisId="rev"
                dataKey="revenue"
                name={`매출액(${bigUnit})`}
                radius={[3, 3, 0, 0]}
                fill="oklch(0.72 0.11 250)"
                fillOpacity={0.75}
              />
              <Line
                yAxisId="eps"
                dataKey="eps"
                name="EPS"
                stroke="oklch(0.62 0.19 30)"
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {d.notes.length > 0 && (
          <p className="text-muted-foreground/80 text-[11px]">{d.notes.join(" · ")}</p>
        )}

        {/* EPS 컨센서스 추이 (당해년도 + 차년도) */}
        {d.epsRevision && (
          <div>
            <h4 className="mb-2 text-xs font-semibold">EPS 컨센서스 추이</h4>
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col style={{ width: "16%" }} />
                <col style={{ width: "21%" }} />
                <col style={{ width: "21%" }} />
                <col style={{ width: "21%" }} />
                <col style={{ width: "21%" }} />
              </colgroup>
              <thead>
                <tr className="text-muted-foreground border-b text-right">
                  <th className="py-1.5 text-left font-medium">시점</th>
                  <th className="py-1.5 font-medium">당해 EPS(E)</th>
                  <th className="py-1.5 pr-3 font-medium">당해 PER(E)</th>
                  <th className="border-l border-dashed py-1.5 pl-3 font-medium">
                    {d.epsRevision.nextFy ? `${d.epsRevision.nextFy} EPS(E)` : "차년도 EPS(E)"}
                  </th>
                  <th className="py-1.5 font-medium">
                    {d.epsRevision.nextFy ? `${d.epsRevision.nextFy} PER(E)` : "차년도 PER(E)"}
                  </th>
                </tr>
              </thead>
              <tbody className="tnum">
                {d.epsRevision.asOf.map((t, i) => (
                  <tr
                    key={t}
                    className={cn("border-b text-right", i % 2 === 1 && "bg-muted/40")}
                  >
                    <td className="py-1.5 text-left">{t}</td>
                    <td className="py-1.5">{won(d.epsRevision!.eps[i])}</td>
                    <td className="py-1.5 pr-3">{mult(d.epsRevision!.per[i])}</td>
                    <td className="border-l border-dashed py-1.5 pl-3">
                      {won(d.epsRevision!.epsNext[i])}
                    </td>
                    <td className="py-1.5">{mult(d.epsRevision!.perNext[i])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 어닝 서프라이즈 — EPS 컨센서스 추이 하단 */}
        {d.earningsSurprise.length > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-semibold">EPS 어닝 서프라이즈</h4>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-right">
                  <th className="py-1.5 text-left font-medium">분기</th>
                  <th className="py-1.5 font-medium">컨센서스</th>
                  <th className="py-1.5 font-medium">실제</th>
                  <th className="py-1.5 font-medium">서프라이즈</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {d.earningsSurprise.map((s) => (
                  <tr key={s.period} className="border-b text-right">
                    <td className="py-1.5 text-left">{s.period.slice(0, 7)}</td>
                    <td className="py-1.5">{won(s.epsEstimate)}</td>
                    <td className="py-1.5">{won(s.epsActual)}</td>
                    <td
                      className={cn(
                        "py-1.5",
                        s.surprisePct != null && s.surprisePct > 0 && "text-up",
                        s.surprisePct != null && s.surprisePct < 0 && "text-down",
                      )}
                    >
                      {s.surprisePct == null ? "-" : pct(s.surprisePct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {d.deepLinks.length > 0 && (
          <DeepLinkList
            title="컨센서스 원본 (영업이익 추정 등 상세)"
            links={d.deepLinks}
            hint="영업이익·순이익 컨센서스, 추정치 리비전 이력은 원본에서 확인"
          />
        )}
      </CardContent>
    </Card>
  );
}
