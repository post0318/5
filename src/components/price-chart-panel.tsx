"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiFetch } from "@/lib/query";
import { cn } from "@/lib/utils";
import { formatCurrency, formatMoneyWithUnits, type CurrencyCode } from "@/lib/format";
import type { MarketId } from "@/lib/markets/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const AXIS_TICK = { fontSize: 10, fill: "var(--muted-foreground)" } as const;
const TOOLTIP_CONTENT_STYLE = {
  fontSize: 11,
  padding: "6px 10px",
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--popover-foreground)",
} as const;

/** 볼린저밴드·MACD 없이 종가(또는 시가총액)만 — 기본 1개월. */
const PERIODS = [1 / 12, 0.25, 0.5, 1, 3, 5, 10] as const;
const DEFAULT_YEARS: number = PERIODS[0];
const periodLabel = (y: number) => (y < 1 ? `${Math.round(y * 12)}개월` : `${y}년`);

interface OhlcRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface ChartRow extends OhlcRow {
  /** [low, high] — Recharts 범위(플로팅) 바용. */
  hl: [number, number];
  market: MarketId;
}

interface PriceChartResp {
  rows: OhlcRow[];
  maxYears: number;
}

/** 캔들스틱 — 몸통(시가~종가 박스) + 위아래 꼬리(고가~저가 선), HTS 표준 모양. */
function CandleShape(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: ChartRow;
}) {
  const { x, y, width, height, payload } = props;
  if (x == null || y == null || width == null || height == null || !payload) return null;
  const { open, high, low, close, market } = payload;
  const range = high - low || 1;
  const cx = x + width / 2;
  const yFor = (v: number) => y + height * (1 - (v - low) / range);
  const up = close >= open;
  const color =
    market === "kr" ? (up ? "var(--kr-up)" : "var(--kr-down)") : up ? "var(--up)" : "var(--down)";
  const bodyW = Math.max(width * 0.62, 2);
  const bodyTop = yFor(Math.max(open, close));
  const bodyBottom = yFor(Math.min(open, close));
  const bodyH = Math.max(bodyBottom - bodyTop, 1);
  return (
    <g>
      <line x1={cx} y1={y} x2={cx} y2={y + height} stroke={color} strokeWidth={1} />
      <rect
        x={cx - bodyW / 2}
        y={bodyTop}
        width={bodyW}
        height={bodyH}
        fill={color}
        stroke={color}
      />
    </g>
  );
}

export function PriceChartPanel({
  market,
  symbol,
  yahoo,
  currency,
  mode,
  sharesOutstanding,
  onClose,
}: {
  market: MarketId;
  symbol: string;
  yahoo?: string | null;
  currency?: CurrencyCode | null;
  /** "price": 종가 추이 · "marketcap": 시가총액 추이(종가 × 현재 상장주식수 근사치) */
  mode: "price" | "marketcap";
  sharesOutstanding?: number | null;
  onClose: () => void;
}) {
  const [years, setYears] = useState<number>(DEFAULT_YEARS);
  const [chartType, setChartType] = useState<"line" | "bar">("bar");
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
    return opts.length ? opts : [{ y: maxYears || DEFAULT_YEARS, label: "최대" }];
  }, [maxYears]);

  const rows = useMemo(() => {
    const all = q.data?.rows ?? [];
    if (all.length === 0) return [];
    const sliced =
      years >= maxYears - 1e-9
        ? all // "최대" 선택 또는 보유기간이 선택폭보다 짧음
        : all.filter((r) => {
            const cutoff = new Date();
            cutoff.setMonth(cutoff.getMonth() - Math.round(years * 12));
            return r.date >= cutoff.toISOString().slice(0, 10);
          });
    const mult = mode === "marketcap" ? sharesOutstanding : null;
    const scaled =
      mult == null
        ? sliced
        : sliced.map((r) => ({
            date: r.date,
            open: r.open * mult,
            high: r.high * mult,
            low: r.low * mult,
            close: r.close * mult,
          }));
    return scaled.map((r) => ({ ...r, hl: [r.low, r.high] as [number, number], market }));
  }, [q.data, years, maxYears, mode, sharesOutstanding, market]);

  // 시가총액 추이는 과거 상장주식수 이력이 없어 현재 주식수로 근사(다른 화면의
  // 과거 시가총액 근사와 동일한 관례 — dart-highlights.ts 참고).
  const noMarketCap = mode === "marketcap" && sharesOutstanding == null;

  const fmt = (v: number) =>
    mode === "marketcap" ? formatMoneyWithUnits(v, market) : formatCurrency(v, currency ?? "USD");
  const xTick = (d: string) => d.slice(2, 7);
  const seriesName = mode === "marketcap" ? "시가총액" : "종가";

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm">{mode === "marketcap" ? "시가총액 추이" : "가격 추이"}</CardTitle>
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
          <div className="border-border flex overflow-hidden rounded-md border text-xs">
            {(["line", "bar"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setChartType(t)}
                className={cn(
                  "px-2 py-0.5 transition-colors",
                  chartType === t
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted text-muted-foreground",
                )}
                title={t === "bar" ? "시가·고가·저가·종가(OHLC) 캔들차트" : undefined}
              >
                {t === "line" ? "라인" : "캔들"}
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
        {noMarketCap && (
          <p className="text-muted-foreground text-xs">
            발행주식수 정보가 없어 시가총액 추이를 계산할 수 없습니다.
          </p>
        )}
        {!noMarketCap && q.isLoading && <Skeleton className="h-56 w-full" />}
        {!noMarketCap && q.isError && (
          <p className="text-destructive text-xs">{(q.error as Error).message}</p>
        )}
        {!noMarketCap && q.data && rows.length > 0 && (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
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
                  width={mode === "marketcap" ? 100 : 54}
                  domain={["auto", "auto"]}
                  tickFormatter={fmt}
                />
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  labelFormatter={(l) => String(l)}
                  content={({ active, label, payload }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0].payload as ChartRow;
                    return (
                      <div style={TOOLTIP_CONTENT_STYLE}>
                        <div className="mb-0.5 font-medium">{String(label)}</div>
                        {chartType === "bar" ? (
                          <div className="space-y-0.5">
                            <div>시가 {fmt(row.open)}</div>
                            <div>고가 {fmt(row.high)}</div>
                            <div>저가 {fmt(row.low)}</div>
                            <div>종가 {fmt(row.close)}</div>
                          </div>
                        ) : (
                          <div>
                            {seriesName} {fmt(row.close)}
                            {mode === "price" && currency ? ` ${currency}` : ""}
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                {chartType === "line" ? (
                  <Line
                    type="monotone"
                    dataKey="close"
                    name={seriesName}
                    stroke="oklch(0.62 0.13 250)"
                    strokeWidth={1.6}
                    dot={false}
                    isAnimationActive={false}
                  />
                ) : (
                  <Bar dataKey="hl" name={seriesName} shape={CandleShape} isAnimationActive={false} />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        {!noMarketCap && q.data && rows.length === 0 && (
          <p className="text-muted-foreground text-xs">가격 데이터가 없습니다.</p>
        )}
      </CardContent>
    </Card>
  );
}
