"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiFetch } from "@/lib/query";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import type { MarketId } from "@/lib/markets/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const AXIS_TICK = { fontSize: 10, fill: "var(--muted-foreground)" } as const;
const TOOLTIP_STYLE = {
  contentStyle: {
    fontSize: 11,
    padding: "6px 10px",
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--popover-foreground)",
  },
} as const;

/** 볼린저밴드·MACD 없이 종가만 — 기본 1개월(0.25년). */
const PERIODS = [0.25, 0.5, 1, 3, 5, 10] as const;
const periodLabel = (y: number) => (y < 1 ? `${Math.round(y * 12)}개월` : `${y}년`);

interface PriceChartResp {
  rows: { date: string; close: number }[];
  maxYears: number;
}

export function PriceChartPanel({
  market,
  symbol,
  yahoo,
  currency,
  onClose,
}: {
  market: MarketId;
  symbol: string;
  yahoo?: string | null;
  currency?: string | null;
  onClose: () => void;
}) {
  const [years, setYears] = useState<number>(0.25);
  const q = useQuery({
    queryKey: ["price-chart", market, symbol, yahoo],
    queryFn: () =>
      apiFetch<PriceChartResp>(
        `/api/markets/${market}/${symbol}/price-chart` +
          (yahoo ? `?yahoo=${encodeURIComponent(yahoo)}` : ""),
      ),
    staleTime: 60 * 60_000,
  });

  const maxYears = q.data?.maxYears ?? 0;

  // 종목의 실제 보유 기간을 넘는 기간 옵션은 숨기고, 마지막에 "최대"를 추가
  // (예: 2023년 상장 종목은 "1개월·3개월·6개월·1년·최대"만 — 5년·10년은 안 보임).
  const options = useMemo(() => {
    const opts: { y: number; label: string }[] = [];
    for (const y of PERIODS) {
      if (y <= maxYears + 1e-9) opts.push({ y, label: periodLabel(y) });
      else break;
    }
    const lastY = opts.at(-1)?.y ?? 0;
    if (maxYears > lastY + 0.01) opts.push({ y: maxYears, label: "최대" });
    return opts.length ? opts : [{ y: maxYears || 0.25, label: "최대" }];
  }, [maxYears]);

  const rows = useMemo(() => {
    const all = q.data?.rows ?? [];
    if (all.length === 0) return [];
    if (years >= maxYears - 1e-9) return all; // "최대" 선택 또는 보유기간이 선택폭보다 짧음
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - Math.round(years * 12));
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    return all.filter((r) => r.date >= cutoffIso);
  }, [q.data, years, maxYears]);

  const fmt = (v: number) => formatNumber(v, 2);
  const xTick = (d: string) => d.slice(2, 7);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm">가격 추이</CardTitle>
        <div className="flex items-center gap-1">
          <div className="border-border flex overflow-hidden rounded-md border text-xs">
            {options.map((o) => (
              <button
                key={o.label}
                onClick={() => setYears(o.y)}
                className={cn(
                  "px-2 py-0.5 transition-colors",
                  years === o.y
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted text-muted-foreground",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground ml-1 text-xs underline underline-offset-2"
          >
            닫기
          </button>
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading && <Skeleton className="h-56 w-full" />}
        {q.isError && <p className="text-destructive text-xs">{(q.error as Error).message}</p>}
        {q.data && rows.length > 0 && (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid
                  stroke="var(--muted-foreground)"
                  strokeDasharray="1 3"
                  strokeOpacity={0.35}
                />
                <XAxis
                  dataKey="date"
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={xTick}
                  minTickGap={40}
                />
                <YAxis
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  width={54}
                  domain={["auto", "auto"]}
                  tickFormatter={fmt}
                />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  labelFormatter={(l) => String(l)}
                  formatter={(v) => [`${fmt(v as number)}${currency ? ` ${currency}` : ""}`, "종가"]}
                />
                <Line
                  type="monotone"
                  dataKey="close"
                  name="종가"
                  stroke="oklch(0.62 0.13 250)"
                  strokeWidth={1.6}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        {q.data && rows.length === 0 && (
          <p className="text-muted-foreground text-xs">가격 데이터가 없습니다.</p>
        )}
      </CardContent>
    </Card>
  );
}
