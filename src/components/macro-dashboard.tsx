"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowDownRight, ArrowRight, ArrowUpRight, ExternalLink, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/query";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip as UITooltip,
  TooltipContent as UITooltipContent,
  TooltipProvider,
  TooltipTrigger as UITooltipTrigger,
} from "@/components/ui/tooltip";

type Verdict = "positive" | "negative" | "neutral";
type Direction = "up" | "down" | "flat";

// ── 공통 차트 스타일 ──────────────────────────────────────────────
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
  labelStyle: { color: "var(--muted-foreground)", marginBottom: 2, fontSize: 10 },
  cursor: { stroke: "var(--border)", strokeWidth: 1 },
} as const;

interface Indicator {
  id: string;
  name: string;
  category: "market" | "leading" | "core";
  unit: string;
  note: string;
  frequency: string;
  transform: "level" | "yoy";
  latest: { date: string; value: number } | null;
  change6m: number | null;
  change12m: number | null;
  direction6m: Direction;
  verdict: Verdict;
  verdictReason: string;
  guide: { when: string; verdict: Verdict; note?: string }[];
  series: { date: string; value: number }[];
}
interface IndexQuote {
  key: string;
  name: string;
  region: "kr" | "us" | "jp" | "cm";
  value: number | null;
  change: number | null;
  changePct: number | null;
  asOf: string | null;
  source: string;
}
interface FearGreed {
  score: number;
  rating: string;
  ratingKo: string;
  asOf: string;
  prevClose: number;
  prev1w: number;
  prev1m: number;
  prev1y: number;
  history: { date: string; value: number }[];
  components: {
    key: string;
    label: string;
    valueLabel: string;
    score: number | null;
    rating: string | null;
    history: { date: string; value: number }[];
    overlay?: { label: string; history: { date: string; value: number }[] };
  }[];
  source: string;
  deepLink: string;
  vixHistoricalAvg?: number | null;
  vkospiAvg?: number | null;
  creditAvg?: number | null;
}
interface Dashboard {
  asOf: string;
  indicators: Indicator[];
  summary: { positive: number; negative: number; neutral: number };
  indices: IndexQuote[];
  fearGreed: FearGreed | null;
  krFearGreed:
    | (FearGreed & { ready?: boolean; componentsReady?: number; vkospiAvg?: number | null; creditAvg?: number | null })
    | null;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  positive: "긍정",
  negative: "부정",
  neutral: "중립",
};
const VERDICT_CLASS: Record<Verdict, string> = {
  positive: "bg-up/15 text-up border-up/30",
  negative: "bg-down/15 text-down border-down/30",
  neutral: "bg-muted text-muted-foreground border-border",
};

/**
 * 시계열을 기준선 기준으로 좋음(divGood)/나쁨(divBad) 두 색 선으로 분리.
 * 교차 구간엔 정확히 y=기준선인 보간점을 삽입해 색이 겹치지 않고 이어지게 한다.
 */
function splitByThreshold<T extends { date: string }>(
  rows: (T & { splitVal: number })[],
  threshold: number,
  goodWhenAbove: boolean,
): (T & { divGood: number | null; divBad: number | null })[] {
  const isGood = (v: number) => (goodWhenAbove ? v >= threshold : v < threshold);
  const out: (T & { divGood: number | null; divBad: number | null })[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    if (i > 0) {
      const prev = rows[i - 1];
      const crossed = prev.splitVal >= threshold !== (cur.splitVal >= threshold);
      if (crossed && cur.splitVal !== prev.splitVal) {
        const t = (threshold - prev.splitVal) / (cur.splitVal - prev.splitVal);
        const d1 = Date.parse(prev.date);
        const d2 = Date.parse(cur.date);
        const midDate = new Date(d1 + (d2 - d1) * Math.min(Math.max(t, 0), 1)).toISOString();
        out.push({ ...cur, date: midDate, divGood: threshold, divBad: threshold });
      }
    }
    const g = isGood(cur.splitVal);
    out.push({ ...cur, divGood: g ? cur.splitVal : null, divBad: g ? null : cur.splitVal });
  }
  return out;
}

function DirIcon({ dir }: { dir: Direction }) {
  const I = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : ArrowRight;
  return <I className="size-3.5" />;
}

interface IndexChartRow {
  date: string;
  close: number;
  bbU: number | null;
  bbM: number | null;
  bbL: number | null;
  macd: number | null;
  signal: number | null;
  hist: number | null;
}
interface IndexChartResp {
  key: string;
  name: string;
  rows: IndexChartRow[];
}

export function MacroDashboard() {
  const [selIdx, setSelIdx] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["macro"],
    queryFn: () => apiFetch<Dashboard>("/api/macro"),
    staleTime: 60 * 60_000,
  });

  const nasdaq = useMemo(
    () => q.data?.indicators.find((i) => i.id === "NASDAQCOM") ?? null,
    [q.data],
  );

  return (
   <TooltipProvider delayDuration={0}>
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-semibold">글로벌 시장 지수</h1>
          <span className="text-muted-foreground text-sm">{q.data?.asOf ?? "-"}</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={q.isFetching ? "size-4 animate-spin" : "size-4"} />
          새로고침
        </Button>
      </div>

      {q.isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-52 w-full" />
          ))}
        </div>
      )}
      {q.isError && <p className="text-destructive text-sm">{(q.error as Error).message}</p>}

      {q.data && q.data.indices.length > 0 && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            {q.data.indices.map((ix) => (
              <button
                key={ix.key}
                onClick={() => setSelIdx((k) => (k === ix.key ? null : ix.key))}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  selIdx === ix.key
                    ? "border-primary bg-secondary"
                    : "border-border hover:bg-muted/50",
                )}
              >
                <div className="text-muted-foreground text-xs">{ix.name}</div>
                <div className="tnum mt-1 text-lg font-semibold">
                  {ix.value != null ? formatNumber(ix.value, 2) : "-"}
                </div>
                <div
                  className={cn(
                    "tnum text-xs",
                    ix.changePct != null && ix.changePct > 0 && "text-up",
                    ix.changePct != null && ix.changePct < 0 && "text-down",
                    (ix.changePct == null || ix.changePct === 0) && "text-muted-foreground",
                  )}
                >
                  {ix.changePct != null
                    ? `${ix.changePct > 0 ? "+" : ""}${formatNumber(ix.changePct, 2)}%`
                    : "-"}
                </div>
              </button>
            ))}
          </div>
          {selIdx && (
            <IndexChartPanel idxKey={selIdx} onClose={() => setSelIdx(null)} />
          )}
        </div>
      )}

      {q.data && (
        <>
          {q.data.fearGreed && <FearGreedCard fg={q.data.fearGreed} />}

          {q.data.krFearGreed && <FearGreedCard fg={q.data.krFearGreed} showLink={false} />}

          <Card>
            <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 text-sm">
              <span className="font-medium">종합 신호</span>
              <span className="text-up">긍정 {q.data.summary.positive}</span>
              <span className="text-down">부정 {q.data.summary.negative}</span>
              <span className="text-muted-foreground">중립 {q.data.summary.neutral}</span>
              <span className="text-muted-foreground ml-auto text-xs">
                아래 지표들의 자동 판정 집계 · 다수 긍정이면 확장 국면, 스프레드·심리 악화면 후퇴 경계
              </span>
            </CardContent>
          </Card>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">핵심 지표</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {q.data.indicators
                .filter((i) => i.category === "core")
                .map((ind) => (
                  <IndicatorCard key={ind.id} ind={ind} nasdaq={nasdaq} />
                ))}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">경기 선행지표</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {q.data.indicators
                .filter((i) => i.category === "leading")
                .map((ind) => (
                  <IndicatorCard key={ind.id} ind={ind} nasdaq={nasdaq} />
                ))}
            </div>
          </section>

          <p className="text-muted-foreground text-xs">
            신호는 최근 6개월 방향 + 레벨 기준의 자동 판정입니다. 투자 조언이 아니며,
            지표별 원계열은 FRED(fred.stlouisfed.org)에서 확인하세요.
          </p>
        </>
      )}
    </div>
   </TooltipProvider>
  );
}

const GREEN = "oklch(0.62 0.17 150)";
const RED = "oklch(0.58 0.21 27)";

const CHART_YEARS = [1, 3, 5, 10] as const;

function IndexChartPanel({ idxKey, onClose }: { idxKey: string; onClose: () => void }) {
  const [years, setYears] = useState<(typeof CHART_YEARS)[number]>(1);
  const q = useQuery({
    queryKey: ["index-chart", idxKey, years],
    queryFn: () => apiFetch<IndexChartResp>(`/api/macro/index-chart/${idxKey}?y=${years}`),
    staleTime: 60 * 60_000,
  });

  const rows = useMemo(() => {
    const r = q.data?.rows ?? [];
    return r.map((d) => ({
      ...d,
      histUp: d.hist != null && d.hist >= 0 ? d.hist : null,
      histDown: d.hist != null && d.hist < 0 ? d.hist : null,
    }));
  }, [q.data]);

  const fmt = (v: number | string) => formatNumber(typeof v === "number" ? v : Number(v), 2);
  const xTick = (d: string) => d.slice(2, 7);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm">
          {q.data?.name ?? idxKey} · 일봉 · 볼린저밴드(20, ±2σ) · MACD(12/26/9)
        </CardTitle>
        <div className="flex items-center gap-1">
          <div className="border-border flex overflow-hidden rounded-md border text-xs">
            {CHART_YEARS.map((y) => (
              <button
                key={y}
                onClick={() => setYears(y)}
                className={cn(
                  "px-2 py-0.5 transition-colors",
                  years === y
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted text-muted-foreground",
                )}
              >
                {y}년
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
      <CardContent className="space-y-1">
        {q.isLoading && <Skeleton className="h-72 w-full" />}
        {q.isError && (
          <p className="text-destructive text-xs">{(q.error as Error).message}</p>
        )}
        {q.data && rows.length > 0 && (
          <>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--muted-foreground)" strokeDasharray="1 3" strokeOpacity={0.35} />
                  <XAxis dataKey="date" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={xTick} minTickGap={40} />
                  <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={54} domain={["auto", "auto"]} tickFormatter={fmt} />
                  <Tooltip {...TOOLTIP_STYLE} labelFormatter={(l) => String(l)} formatter={(v, n) => [fmt(v as number), String(n)]} />
                  <Area
                    type="monotone"
                    dataKey={["bbL", "bbU"] as unknown as string}
                    name="볼린저밴드"
                    stroke="none"
                    fill="var(--foreground)"
                    fillOpacity={0.07}
                    isAnimationActive={false}
                    connectNulls
                  />
                  <Line type="monotone" dataKey="bbU" name="상단" stroke="var(--muted-foreground)" strokeWidth={0.8} strokeOpacity={0.6} dot={false} isAnimationActive={false} connectNulls />
                  <Line type="monotone" dataKey="bbL" name="하단" stroke="var(--muted-foreground)" strokeWidth={0.8} strokeOpacity={0.6} dot={false} isAnimationActive={false} connectNulls />
                  <Line type="monotone" dataKey="bbM" name="중심(20)" stroke="var(--muted-foreground)" strokeWidth={0.9} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
                  <Line type="monotone" dataKey="close" name={q.data.name} stroke="oklch(0.62 0.13 250)" strokeWidth={1.6} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--muted-foreground)" strokeDasharray="1 3" strokeOpacity={0.35} />
                  <XAxis dataKey="date" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={xTick} minTickGap={40} />
                  <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={54} tickFormatter={(v: number) => v.toFixed(1)} />
                  <Tooltip {...TOOLTIP_STYLE} labelFormatter={(l) => String(l)} formatter={(v, n) => [Number(v).toFixed(3), String(n)]} />
                  <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeOpacity={0.5} />
                  <Area type="monotone" dataKey="histUp" name="오실레이터" stroke={GREEN} strokeWidth={0.8} fill={GREEN} fillOpacity={0.25} isAnimationActive={false} connectNulls={false} />
                  <Area type="monotone" dataKey="histDown" name="오실레이터" stroke={RED} strokeWidth={0.8} fill={RED} fillOpacity={0.25} isAnimationActive={false} connectNulls={false} />
                  <Line type="monotone" dataKey="macd" name="MACD" stroke="oklch(0.62 0.13 250)" strokeWidth={1.2} dot={false} isAnimationActive={false} connectNulls />
                  <Line type="monotone" dataKey="signal" name="시그널" stroke="oklch(0.70 0.16 50)" strokeWidth={1.2} dot={false} isAnimationActive={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="text-muted-foreground/80 text-[11px]">
              Yahoo Finance · 개인용. 가격선(파랑) / 볼린저 중심선(점선) · 하단 MACD 오실레이터(12/26/9,
              히스토그램=MACD−시그널)
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// 색상 스톱 (value → oklch). 공포=빨강/주황, 중립=금색, 탐욕=녹색(밝→진)
const FG_STOPS: { at: number; l: number; c: number; h: number }[] = [
  { at: 0, l: 0.55, c: 0.21, h: 27 }, // 극도의 공포 — 진한 빨강
  { at: 25, l: 0.7, c: 0.18, h: 50 }, // 공포 — 주황
  { at: 50, l: 0.84, c: 0.16, h: 88 }, // 중립 — 금색/황
  { at: 75, l: 0.82, c: 0.13, h: 150 }, // 탐욕 — 연한 녹색
  { at: 100, l: 0.5, c: 0.16, h: 166 }, // 극도의 탐욕 — 진한 청록
];

function fgColor(score: number): string {
  const v = Math.min(100, Math.max(0, score));
  let a = FG_STOPS[0];
  let b = FG_STOPS[FG_STOPS.length - 1];
  for (let i = 0; i < FG_STOPS.length - 1; i++) {
    if (v >= FG_STOPS[i].at && v <= FG_STOPS[i + 1].at) {
      a = FG_STOPS[i];
      b = FG_STOPS[i + 1];
      break;
    }
  }
  const t = b.at === a.at ? 0 : (v - a.at) / (b.at - a.at);
  const lerp = (x: number, y: number) => x + (y - x) * t;
  return `oklch(${lerp(a.l, b.l).toFixed(3)} ${lerp(a.c, b.c).toFixed(3)} ${lerp(a.h, b.h).toFixed(1)})`;
}

const RATING_KO_OF = (score: number): string => {
  if (score < 25) return "극도의 공포";
  if (score < 45) return "공포";
  if (score <= 55) return "중립";
  if (score <= 75) return "탐욕";
  return "극도의 탐욕";
};

/** CNN Fear & Greed 원본 스타일 게이지 (약 200° 아크 + 그라데이션 + 아크 위 포인터) */
function FearGreedGauge({
  score,
  history,
}: {
  score: number;
  history?: { label: string; value: number }[];
}) {
  const CX = 130;
  const CY = 118;
  const R = 96;
  const SW = 18;
  const SWEEP = 200; // 전체 각도
  const START = -SWEEP / 2; // 위(12시) 기준

  // value(0-100) → 각도(위 기준, 시계방향 +)
  const angleOf = (v: number) => START + (Math.min(100, Math.max(0, v)) / 100) * SWEEP;
  const pt = (v: number, r: number) => {
    const rad = (angleOf(v) * Math.PI) / 180;
    return { x: CX + r * Math.sin(rad), y: CY - r * Math.cos(rad) };
  };

  const N = 60;
  const segs = Array.from({ length: N }, (_, i) => {
    const v1 = (i / N) * 100;
    const v2 = ((i + 1) / N) * 100;
    const p1 = pt(v1, R);
    const p2 = pt(v2, R);
    return { d: `M ${p1.x} ${p1.y} A ${R} ${R} 0 0 1 ${p2.x} ${p2.y}`, color: fgColor((v1 + v2) / 2) };
  });

  const zoneLabels = [
    { at: 12.5, text: "극도의 공포" },
    { at: 35, text: "공포" },
    { at: 50, text: "중립" },
    { at: 65, text: "탐욕" },
    { at: 87.5, text: "극도의 탐욕" },
  ];

  const marker = pt(score, R);
  const markerAngle = angleOf(score);

  return (
    <svg
      viewBox="0 0 260 176"
      className="w-full max-w-[340px]"
      role="img"
      aria-label={`Fear & Greed ${score}`}
    >
      {/* 그라데이션 아크 */}
      {segs.map((s, i) => (
        <path key={i} d={s.d} stroke={s.color} strokeWidth={SW} fill="none" strokeLinecap="butt" />
      ))}

      {/* 구간 라벨 */}
      {zoneLabels.map((z) => {
        const p = pt(z.at, R + SW / 2 + 9);
        return (
          <text
            key={z.text}
            x={p.x}
            y={p.y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="8"
            fill="var(--muted-foreground)"
          >
            {z.text}
          </text>
        );
      })}

      {/* 과거값 점 */}
      {(history ?? []).map((h) => {
        const p = pt(h.value, R);
        return (
          <g key={h.label}>
            <circle cx={p.x} cy={p.y} r={2.6} fill="var(--background)" stroke="var(--muted-foreground)" strokeWidth={1.4} />
          </g>
        );
      })}

      {/* 현재값 포인터 (아크 위 삼각형, 안쪽을 가리킴) */}
      <g transform={`rotate(${markerAngle} ${marker.x} ${marker.y})`}>
        <polygon
          points={`${marker.x - 6},${marker.y + SW / 2 + 7} ${marker.x + 6},${marker.y + SW / 2 + 7} ${marker.x},${marker.y - SW / 2 - 1}`}
          fill="var(--foreground)"
          stroke="var(--background)"
          strokeWidth={1.5}
        />
      </g>

      {/* 중앙: 점수 + 등급 */}
      <text x={CX} y={CY - 30} textAnchor="middle" fontSize="40" fontWeight="800" fill={fgColor(score)}>
        {Math.round(score)}
      </text>
      <text x={CX} y={CY - 8} textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--foreground)">
        {RATING_KO_OF(score)}
      </text>
      <text x={CX} y={CY + 40} textAnchor="middle" fontSize="8" fill="var(--muted-foreground)">
        지금 시장을 움직이는 감정
      </text>
    </svg>
  );
}

const SHORT_COMPONENT: Record<string, string> = {
  market_momentum_sp125: "모멘텀",
  stock_price_strength: "주가강도",
  stock_price_breadth: "주가폭",
  put_call_options: "풋/콜",
  market_volatility_vix: "변동성",
  safe_haven_demand: "안전자산",
  junk_bond_demand: "정크본드",
  // 한국 F&G
  kr_momentum: "모멘텀",
  kr_strength: "주가강도",
  kr_breadth: "주가폭",
  kr_vkospi: "변동성",
  kr_safehaven: "안전자산",
  kr_credit: "정크본드",
  kr_putcall: "풋/콜",
};

/** 원본 값이 오를 때 F&G 점수(탐욕)도 오르는가? (false면 역방향) */
const HIGHER_RAW_IS_GREEDY: Record<string, boolean> = {
  market_momentum_sp125: true,
  stock_price_strength: true,
  stock_price_breadth: true,
  put_call_options: false, // 풋 많음 = 공포
  market_volatility_vix: false, // VIX 높음 = 공포
  safe_haven_demand: true, // 주식 > 채권 = 위험선호
  junk_bond_demand: false, // 스프레드 확대 = 공포
  // 한국 F&G
  kr_momentum: true,
  kr_strength: true,
  kr_breadth: true,
  kr_vkospi: false, // 변동성 높음 = 공포
  kr_safehaven: true,
  kr_credit: false, // 스프레드 확대 = 공포
  kr_putcall: false, // 풋 우위 = 공포
};

/**
 * 세부지표의 최근(약 1개월) 점수 방향: 1=상승(탐욕쪽), -1=하락, 0=변화없음
 *
 * 원본 값을 가용 히스토리 전체 구간에서 0~100으로 정규화(min-max)한 뒤
 * (역방향 지표는 100 − normalize), 현재 점수와 약 21틱(≈1개월) 전 점수를 비교.
 * 정규화 후 비교라 지표별 스케일 차이(지수 7000 vs 스프레드 1.3)에 무관하게
 * 일관된 임계값(2점)을 쓸 수 있다.
 * (CNN 히스토리는 약 9개월치 → 3년 윈도우는 불가, 가용 구간 전체 사용)
 */
function componentScoreDir(key: string, history: { value: number }[]): -1 | 0 | 1 {
  const vals = history.map((h) => h.value).filter(Number.isFinite);
  if (vals.length < 10) return 0;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (max === min) return 0;

  const invert = !HIGHER_RAW_IS_GREEDY[key];
  const score = (v: number) => {
    const n = ((v - min) / (max - min)) * 100;
    return invert ? 100 - n : n;
  };

  // 직전(바로 전날) 대비 — 상승 시 ▲, 하락 시 ▼, 변화 없으면 –
  const now = score(vals[vals.length - 1]);
  const then = score(vals[vals.length - 2]);
  const diff = now - then;
  if (diff === 0) return 0;
  return diff > 0 ? 1 : -1;
}

function FearGreedCard({ fg, showLink = true }: { fg: FearGreed; showLink?: boolean }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = fg.components.find((c) => c.key === selectedKey) ?? null;

  const trend = (label: string, val: number) => (
    <span className="text-muted-foreground">
      {label}{" "}
      <b className={cn(val > fg.score ? "text-down" : val < fg.score ? "text-up" : "")}>{val}</b>
    </span>
  );

  // 현재 점수가 속한 25단위 구간
  const zone = Math.min(3, Math.floor(fg.score / 25)); // 0..3
  const zoneFill = (idx: number, base: string) =>
    idx === zone ? { fill: base, fillOpacity: 0.22 } : { fill: base, fillOpacity: 0.05 };

  const chartData = selected ? selected.history : fg.history;
  // 지표별로 서버가 표시 구간보다 더 긴 워밍업 구간을 보낼 때, 축·눈금·
  // 렌더를 표시 구간만으로 트리밍하기 위한 용도 (현재 해당 지표 없음).
  const DISPLAY_LIMIT: Record<string, number> = {};
  const displayLimit = selected ? DISPLAY_LIMIT[selected.key] : undefined;
  const displayChartData = useMemo(
    () => (displayLimit && chartData.length > displayLimit ? chartData.slice(-displayLimit) : chartData),
    [chartData, displayLimit],
  );

  // 소수가 있으면 2자리로 (14.6 → 14.60), 정수는 그대로
  const fmtVal = (v: number | string) => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return String(v);
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  };

  // 세부지표별 Y축 고정 눈금 간격 (정크본드=0.1 단위 등)
  const stepByKey: Record<string, number> = {
    junk_bond_demand: 0.1,
    safe_haven_demand: 5, // 5%p 단위
    put_call_options: 0.1,
    kr_putcall: 0.1,
  };
  // 세부지표별 Y축 고정 범위·눈금 (원시값 스케일이 커서 auto 여백이 과한 경우)
  const fixedAxisByKey: Record<string, { domain: [number, number]; step: number }> = {
    stock_price_breadth: { domain: [800, 1400], step: 200 },
  };
  const fixedAxis = useMemo(() => {
    if (!selected) return null;
    const cfg = fixedAxisByKey[selected.key];
    if (!cfg) return null;
    const [min, max] = cfg.domain;
    const ticks: number[] = [];
    for (let v = min; v <= max + 1e-9; v += cfg.step) ticks.push(Math.round(v));
    return { domain: cfg.domain, ticks };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const yStep = selected ? stepByKey[selected.key] : undefined;
  const yAxis = useMemo(() => {
    if (!yStep || !selected) return null;
    const vals = displayChartData.map((d) => d.value).filter(Number.isFinite);
    if (!vals.length) return null;
    // 부동소수 오차 보정 후 step 배수로 스냅
    const snapDown = (x: number) => Math.round(Math.floor(x / yStep + 1e-9) * yStep * 1e6) / 1e6;
    const snapUp = (x: number) => Math.round(Math.ceil(x / yStep - 1e-9) * yStep * 1e6) / 1e6;
    const min = snapDown(Math.min(...vals));
    const max = snapUp(Math.max(...vals));
    const ticks: number[] = [];
    const n = Math.round((max - min) / yStep);
    for (let i = 0; i <= n; i++) {
      ticks.push(Math.round((min + i * yStep) * 1e6) / 1e6);
    }
    return { domain: [min, max] as [number, number], ticks };
  }, [selected, yStep, displayChartData]);

  // 기준선 대비 위/아래를 분리해 색을 다르게 칠하는 지표 설정
  const DIVERGING_CFG: Record<
    string,
    {
      threshold: number;
      aboveIsBad: boolean;
      aboveLabel?: string;
      belowLabel?: string;
      refLabel?: string;
      /** 기준선 색 (파스텔 점선) */
      refColor?: string;
      /** Y축 눈금 간격 */
      tickStep?: number;
      /** 도메인 경계 스냅 단위 */
      domainSnap?: number;
      /** Y축 도메인 고정 [min, max] (데이터 무관) */
      fixedDomain?: [number, number];
      /** true 면 도메인 계산에 threshold 를 섞지 않고 데이터 고점/저점만 사용 */
      domainDataOnly?: boolean;
    }
  > = {
    safe_haven_demand: {
      threshold: 0,
      aboveIsBad: false,
      aboveLabel: "▲ 주식성과가 채권을 능가",
      belowLabel: "▼ 채권성과가 주식을 능가",
      refLabel: "기준선 0",
      refColor: "oklch(0.78 0.08 250)",
    },
    stock_price_strength: {
      threshold: 0,
      aboveIsBad: false,
      aboveLabel: "▲ 신고가 우위 (강세)",
      belowLabel: "▼ 신저가 우위 (약세)",
      refLabel: "기준선 0",
      refColor: "oklch(0.78 0.08 250)",
    },
    market_volatility_vix: {
      // FRED VIXCLS(1990~) 장기 평균 — 매일 갱신되어 값이 조금씩 변함
      threshold: fg.vixHistoricalAvg ?? 19.43,
      aboveIsBad: true,
      aboveLabel: "▲ 역사적 평균 상회 · 변동성 확대",
      belowLabel: "▼ 역사적 평균 하회 · 안정",
      refLabel: `역사적 평균 ${(fg.vixHistoricalAvg ?? 19.43).toFixed(2)}`,
      refColor: "oklch(0.78 0.08 250)",
      tickStep: 5, // 라벨은 5 단위
      domainSnap: 5,
    },
    put_call_options: {
      threshold: 0.7,
      aboveIsBad: true,
      aboveLabel: "▲ 풋 우위 · 공포",
      belowLabel: "▼ 콜 우위 · 낙관",
      refLabel: "패리티 0.70",
      refColor: "oklch(0.78 0.08 250)",
      tickStep: 0.1,
      domainSnap: 0.1,
    },
    // ── 한국 F&G ── (모멘텀은 overlay 방식: KOSPI + 125일선)
    kr_vkospi: {
      threshold: fg.vkospiAvg ?? 20,
      aboveIsBad: true,
      aboveLabel: "▲ 평균 상회 · 변동성 확대 (공포)",
      belowLabel: "▼ 평균 하회 · 안정 (탐욕)",
      refLabel: `장기 평균 ${(fg.vkospiAvg ?? 20).toFixed(1)}`,
      refColor: "oklch(0.78 0.08 250)",
      tickStep: 5,
      domainSnap: 5,
    },
    kr_putcall: {
      threshold: 0.7,
      aboveIsBad: true,
      aboveLabel: "▲ 풋 우위 · 공포",
      belowLabel: "▼ 콜 우위 · 낙관",
      refLabel: "패리티 0.70",
      refColor: "oklch(0.78 0.08 250)",
      tickStep: 0.1,
      domainSnap: 0.1,
    },
    kr_strength: {
      threshold: 0,
      aboveIsBad: false,
      aboveLabel: "▲ 신고가 우위 (강세)",
      belowLabel: "▼ 신저가 우위 (약세)",
      refLabel: "기준선 0",
      refColor: "oklch(0.78 0.08 250)",
    },
    kr_credit: {
      // 장기 평균이 표시 구간과 크게 떨어져 있어 도메인 계산에서 제외
      // (domainDataOnly) — 표시 구간의 고점/저점 기준 자동 패딩.
      // 스프레드 변동폭이 계속 바뀌므로 고정 스텝 대신 자동 눈금 사용
      // (고정 스텝을 쓰면 범위가 넓어졌을 때 눈금이 수십~수백 개로
      // 폭발해 축이 깨짐 — 실제로 한 번 발생했던 버그).
      // 장기 평균 기준선/라벨은 표시하지 않음.
      threshold: fg.creditAvg ?? 6,
      aboveIsBad: true,
      domainDataOnly: true,
    },
    kr_safehaven: {
      threshold: 0,
      aboveIsBad: false,
      aboveLabel: "▲ 주식성과가 채권을 능가",
      belowLabel: "▼ 채권성과가 주식을 능가",
      refLabel: "기준선 0",
      refColor: "oklch(0.78 0.08 250)",
    },
    kr_breadth: {
      // 1000 = 중립. 위(탐욕)=녹색 / 아래(공포)=적색, 교차 시점 보간
      threshold: 1000,
      aboveIsBad: false,
      domainDataOnly: true,
    },
  };
  const divCfg = selected ? DIVERGING_CFG[selected.key] : undefined;

  // 원본 값 + 정규화(0~100) 점수를 함께 보여주는 지표
  const NORM_KEYS = new Set(["junk_bond_demand", "kr_credit"]);
  const showNorm = selected ? NORM_KEYS.has(selected.key) : false;
  const normInvert = selected ? !HIGHER_RAW_IS_GREEDY[selected.key] : false;
  // 정규화 점수가 threshold 이상(직전 대비) 급락한 지점에 빨간 세로 타원 (정크본드)
  const DROP_CFG: Record<string, { threshold: number; style: "ellipse" }> = {
    junk_bond_demand: { threshold: 20, style: "ellipse" },
    kr_credit: { threshold: 20, style: "ellipse" },
  };
  const dropCfg = selected ? DROP_CFG[selected.key] : undefined;
  const dropThreshold = dropCfg?.threshold;
  const dropStyle = dropCfg?.style;
  // 정규화선 색: "direction" = 상승 녹/하락 적, 그 외 = 50 기준 위 녹/아래 적
  const normColorByDirection = selected?.key === "junk_bond_demand";
  // 원본 값에 이동평균선(20·60)을 얹는 지표
  const MA_KEYS = new Set(["stock_price_breadth"]);
  const showMa = selected ? MA_KEYS.has(selected.key) : false;
  const overlay = selected?.overlay ?? null;
  const divergingData = useMemo(() => {
    type Row = { date: string; value: number } & Record<string, unknown>;
    let data: Row[] = chartData as Row[];
    if (divCfg) {
      // 기준선 대비 좋음(녹)/나쁨(적) 두 색 선. 교차점 보간으로 겹침 방지.
      //  - 일반: 기준선 위 = 좋음  · VIX(aboveIsBad): 위 = 나쁨
      data = splitByThreshold(
        chartData.map((d) => ({ ...d, splitVal: d.value })),
        divCfg.threshold,
        !divCfg.aboveIsBad,
      );
    }
    if (overlay) {
      const omap = new Map(overlay.history.map((p) => [p.date, p.value]));
      const withOv = data.map((d) => ({
        ...d,
        overlayValue: omap.get(d.date) ?? null,
      }));
      // 지수(overlayValue) 가 이동평균(value) 위면 녹색, 아래면 적색으로 선 분리
      // (교차점은 양쪽 시리즈에 포함해 선이 끊기지 않게)
      data = withOv.map((d, i) => {
        const rel = (r?: (typeof withOv)[number]) =>
          r && r.overlayValue != null ? r.overlayValue >= r.value : null;
        const here = rel(withOv[i]);
        const prev = rel(withOv[i - 1]);
        const next = rel(withOv[i + 1]);
        const above = here === true || prev === true || next === true;
        const below = here === false || prev === false || next === false;
        return {
          ...d,
          ovAbove: above && d.overlayValue != null ? d.overlayValue : null,
          ovBelow: below && d.overlayValue != null ? d.overlayValue : null,
        };
      });
    }
    if (showNorm) {
      const vals = chartData.map((d) => d.value).filter(Number.isFinite);
      const min = Math.min(...vals);
      const range = Math.max(...vals) - min || 1;
      const normed = data.map((d) => {
        const raw = ((d.value - min) / range) * 100;
        return { ...d, norm: Math.round((normInvert ? 100 - raw : raw) * 10) / 10 };
      });

      // 직전 대비 dropThreshold 이상 급락한 지점 → 빨간 세로 타원 (정크본드)
      const dropInfo = new Map<number, { mid: number; span: number }>();
      if (dropThreshold != null) {
        for (let i = 1; i < normed.length; i++) {
          const span = normed[i - 1].norm - normed[i].norm; // 직전 대비 하락폭
          if (span >= dropThreshold) {
            dropInfo.set(i, { mid: (normed[i - 1].norm + normed[i].norm) / 2, span });
          }
        }
      }
      const marked = normed.map((d, i) => ({
        ...d,
        dropMid: dropInfo.get(i)?.mid ?? null,
        dropSpan: dropInfo.get(i)?.span ?? 0,
      }));

      let split: (typeof marked[number] & { divGood: number | null; divBad: number | null })[];
      if (normColorByDirection) {
        // 상승 구간 = 녹색 / 하락 구간 = 적색 (전환점은 양쪽에 포함해 끊김 방지)
        split = marked.map((d, i) => {
          const endUp =
            i > 0 ? d.norm >= marked[i - 1].norm : marked[i + 1] ? marked[i + 1].norm >= d.norm : true;
          const startUp = marked[i + 1] ? marked[i + 1].norm >= d.norm : endUp;
          return {
            ...d,
            divGood: endUp || startUp ? d.norm : null,
            divBad: !endUp || !startUp ? d.norm : null,
          };
        });
      } else {
        split = splitByThreshold(
          marked.map((d) => ({ ...d, splitVal: d.norm })),
          50,
          true,
        );
      }

      data = split.map((d) => ({ ...d, normUp: d.divGood, normDown: d.divBad }));
    }
    if (showMa) {
      // 원본값에 단순이동평균 20 을 얹고, 원본이 MA20 위면 녹색 / 아래면 적색
      const sma = (period: number) => {
        const out: (number | null)[] = [];
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          sum += (data[i] as { value: number }).value;
          if (i >= period) sum -= (data[i - period] as { value: number }).value;
          out.push(i >= period - 1 ? Math.round((sum / period) * 100) / 100 : null);
        }
        return out;
      };
      const ma20 = sma(20);
      const dir = data.map((d, k) =>
        ma20[k] != null ? (d as { value: number }).value >= (ma20[k] as number) : null,
      );
      data = data.map((d, i) => {
        const v = (d as { value: number }).value;
        // 점 또는 이웃이 해당 상태면 포함 → 전환점에서 선이 끊기지 않음
        const inClass = (c: boolean | null) => dir[i] === c || dir[i - 1] === c || dir[i + 1] === c;
        return {
          ...d,
          ma20: ma20[i],
          maGood: inClass(true) ? v : null,
          maBad: inClass(false) ? v : null,
          maBase: inClass(null) ? v : null, // MA20 산출 전(초기 구간)
        };
      });
    }
    // 워밍업용으로 더 받은 앞부분(예: kr_breadth MA20용 20일)은 렌더링에서 잘라냄
    return displayLimit && data.length > displayLimit ? data.slice(-displayLimit) : data;
  }, [divCfg, chartData, showNorm, normInvert, overlay, dropThreshold, normColorByDirection, showMa, displayLimit]);

  // 다이버징 차트 Y축 (도메인 + 눈금). 데이터 + 기준선 포함.
  const divAxis = useMemo(() => {
    if (!divCfg) return null;
    const vals = displayChartData.map((d) => d.value).filter(Number.isFinite);
    if (!vals.length) return null;
    let lo: number, hi: number;
    if (divCfg.fixedDomain) {
      [lo, hi] = divCfg.fixedDomain;
    } else {
    const rawLo = divCfg.domainDataOnly ? Math.min(...vals) : Math.min(...vals, divCfg.threshold);
    const rawHi = divCfg.domainDataOnly ? Math.max(...vals) : Math.max(...vals, divCfg.threshold);
    const snap = divCfg.domainSnap;
    if (snap) {
      lo = Math.floor(rawLo / snap) * snap;
      hi = Math.ceil(rawHi / snap) * snap;
    } else {
      const pad = (rawHi - rawLo) * 0.1 || 1;
      lo = Math.round((rawLo - pad) * 100) / 100;
      hi = Math.round((rawHi + pad) * 100) / 100;
    }
    }
    let ticks: number[] | undefined;
    if (divCfg.tickStep) {
      ticks = [];
      const n = Math.round((hi - lo) / divCfg.tickStep);
      for (let i = 0; i <= n; i++) {
        ticks.push(Math.round((lo + i * divCfg.tickStep) * 100) / 100);
      }
    }
    return { domain: [lo, hi] as [number, number], ticks };
  }, [divCfg, displayChartData]);
  const divDomain = divAxis?.domain ?? null;

  // 세로 눈금 — F&G 종합은 월 단위, 세부지표는 분기(3개월) 단위
  const gridTicks = useMemo(() => {
    const seen = new Set<string>();
    const ticks: string[] = [];
    for (const d of displayChartData) {
      const [y, m] = d.date.split("-").map(Number);
      const bucket = selected ? `${y}-${Math.floor((m - 1) / 3)}` : `${y}-${m}`;
      if (!seen.has(bucket)) {
        seen.add(bucket);
        ticks.push(d.date);
      }
    }
    return ticks;
  }, [displayChartData, selected]);

  return (
    <div className="space-y-2">
      <h2 className="text-muted-foreground text-sm font-medium">시장 심리·위험</h2>
      <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          {showLink ? (
            <a
              href={fg.deepLink}
              target="_blank"
              rel="noreferrer"
              className="hover:text-primary inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              {fg.source}
              <ExternalLink className="size-3" />
            </a>
          ) : (
            fg.source
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid items-center gap-4 lg:grid-cols-[minmax(240px,320px)_1fr]">
          {/* 왼쪽: 게이지 */}
          <div className="flex justify-center">
            <FearGreedGauge
              score={fg.score}
              history={[
                { label: "전일", value: fg.prevClose },
                { label: "1주", value: fg.prev1w },
                { label: "1개월", value: fg.prev1m },
                { label: "1년", value: fg.prev1y },
              ]}
            />
          </div>

          {/* 오른쪽: 추이 라인차트 */}
          <div className="space-y-1">
            <div className="text-muted-foreground flex items-center justify-between text-xs">
              <span className="text-foreground font-medium">
                {selected ? selected.label : "F&G 종합"}
              </span>
              {selected ? (
                <button
                  className="hover:text-foreground underline underline-offset-2"
                  onClick={() => setSelectedKey(null)}
                >
                  ← 종합으로
                </button>
              ) : (
                <span className="flex gap-3">
                  {trend("전일", fg.prevClose)}
                  {trend("1주", fg.prev1w)}
                  {trend("1개월", fg.prev1m)}
                  {trend("1년", fg.prev1y)}
                </span>
              )}
            </div>
            {selected && (
              <div className="text-muted-foreground text-[11px]">
                {selected.valueLabel}
                {showNorm && " · 원본 값"}
                {showNorm && (
                  <span className="ml-2">
                    · 점선 = 자체 정규화 0~100 (최근 1년 min-max, CNN 점수와 다름 · 우측축,{" "}
                    {normColorByDirection ? (
                      <>
                        <span className="text-up">상승=녹색</span> /{" "}
                        <span className="text-down">하락=적색</span>
                      </>
                    ) : (
                      <>
                        <span className="text-up">50 위=녹색</span> /{" "}
                        <span className="text-down">아래=적색</span>
                      </>
                    )}
                    )
                  </span>
                )}
                {showMa && (
                  <span className="ml-2">
                    · <span style={{ color: "oklch(0.62 0.13 250)" }}>점선 = MA20</span> · 원본선{" "}
                    <span className="text-up">MA20 위=녹색</span> /{" "}
                    <span className="text-down">아래=적색</span>
                  </span>
                )}
                {overlay && (
                  <span className="ml-2">
                    · {overlay.label} 실선 (<span className="text-up">평균 위=녹색</span> /{" "}
                    <span className="text-down">아래=적색</span>) · 점선 = 125일 이동평균
                  </span>
                )}
              </div>
            )}
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={divergingData} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="fgFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--foreground)" stopOpacity={0.10} />
                      <stop offset="100%" stopColor="var(--foreground)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    stroke="var(--muted-foreground)"
                    strokeDasharray="1 3"
                    strokeOpacity={0.4}
                    syncWithTicks
                  />
                  {!selected && (
                    <>
                      <ReferenceArea y1={0} y2={25} {...zoneFill(0, "oklch(0.55 0.21 27)")} ifOverflow="hidden" />
                      <ReferenceArea y1={25} y2={50} {...zoneFill(1, "oklch(0.70 0.18 50)")} ifOverflow="hidden" />
                      <ReferenceArea y1={50} y2={75} {...zoneFill(2, "oklch(0.86 0.12 150)")} ifOverflow="hidden" />
                      <ReferenceArea y1={75} y2={100} {...zoneFill(3, "oklch(0.50 0.16 166)")} ifOverflow="hidden" />
                    </>
                  )}
                  {divCfg && divDomain && (
                    <>
                      {divCfg.aboveLabel && (
                        <ReferenceArea
                          y1={divCfg.threshold}
                          y2={divDomain[1]}
                          fillOpacity={0}
                          label={{
                            value: divCfg.aboveLabel,
                            position: "insideTopLeft",
                            fontSize: 9,
                            fill: "var(--muted-foreground)",
                          }}
                        />
                      )}
                      {divCfg.belowLabel && (
                        <ReferenceArea
                          y1={divDomain[0]}
                          y2={divCfg.threshold}
                          fillOpacity={0}
                          label={{
                            value: divCfg.belowLabel,
                            position: "insideBottomLeft",
                            fontSize: 9,
                            fill: "var(--muted-foreground)",
                          }}
                        />
                      )}
                      <ReferenceLine
                        y={divCfg.threshold}
                        stroke={divCfg.refColor ?? "var(--muted-foreground)"}
                        strokeWidth={1.25}
                        strokeDasharray="4 3"
                        strokeOpacity={divCfg.refColor ? 0.85 : 0.4}
                        label={
                          divCfg.refLabel
                            ? {
                                value: divCfg.refLabel,
                                position: "insideLeft",
                                fontSize: 10,
                                fontWeight: 600,
                                fill: divCfg.refColor ?? "var(--foreground)",
                                dy: -10,
                              }
                            : undefined
                        }
                      />
                    </>
                  )}
                  <XAxis
                    dataKey="date"
                    tick={AXIS_TICK}
                    axisLine={false}
                    tickLine={false}
                    ticks={gridTicks}
                    interval={0}
                    tickMargin={8}
                    tickFormatter={(d: string) => d.slice(0, 7)}
                  />
                  <YAxis
                    tick={AXIS_TICK}
                    axisLine={false}
                    tickLine={false}
                    width={selected ? 46 : 30}
                    domain={
                      divAxis?.domain ??
                      fixedAxis?.domain ??
                      (yAxis ? yAxis.domain : selected ? ["auto", "auto"] : [0, 100])
                    }
                    ticks={
                      divAxis
                        ? divAxis.ticks
                        : fixedAxis
                          ? fixedAxis.ticks
                          : yAxis
                            ? yAxis.ticks
                            : selected
                              ? undefined
                              : [0, 25, 50, 75, 100]
                    }
                    tickFormatter={
                      yAxis || divAxis
                        ? (v: number) => String(Math.round(v * 100) / 100)
                        : fmtVal
                    }
                    allowDecimals
                  />
                  {showNorm && (
                    <YAxis
                      yAxisId="norm"
                      orientation="right"
                      tick={AXIS_TICK}
                      axisLine={false}
                      tickLine={false}
                      width={28}
                      domain={[0, 100]}
                      ticks={[0, 25, 50, 75, 100]}
                    />
                  )}
                  <Tooltip
                    {...TOOLTIP_STYLE}
                    formatter={(v, name) => {
                      const n =
                        name === "norm"
                          ? "정규화 점수 (0~100)"
                          : name === "value" || name == null
                            ? overlay
                              ? "이동평균"
                              : selected
                                ? selected.valueLabel
                                : "F&G"
                            : String(name);
                      return [fmtVal(v as number), n];
                    }}
                  />
                  {divCfg ? (
                    <>
                      {/* 툴팁용 투명 기준선 */}
                      <Area
                        type="monotone"
                        dataKey="value"
                        name={selected?.valueLabel ?? "값"}
                        stroke="none"
                        fill="none"
                        dot={false}
                        activeDot={false}
                        isAnimationActive={false}
                      />
                      {/* 좋은 구간 = 녹색 */}
                      <Area
                        type="monotone"
                        dataKey="divGood"
                        name={selected?.valueLabel ?? "값"}
                        tooltipType="none"
                        stroke="oklch(0.62 0.17 150)"
                        strokeWidth={1.6}
                        fill="none"
                        connectNulls={false}
                        dot={false}
                        activeDot={{ r: 3, strokeWidth: 0 }}
                        isAnimationActive={false}
                      />
                      {/* 나쁜 구간 = 적색 */}
                      <Area
                        type="monotone"
                        dataKey="divBad"
                        name={selected?.valueLabel ?? "값"}
                        tooltipType="none"
                        stroke="oklch(0.58 0.21 27)"
                        strokeWidth={1.6}
                        fill="none"
                        connectNulls={false}
                        dot={false}
                        activeDot={{ r: 3, strokeWidth: 0 }}
                        isAnimationActive={false}
                      />
                      {/* 보조선(overlay, 예: MVO) — 점선으로 구분 */}
                      {overlay && (
                        <Area
                          type="monotone"
                          dataKey="overlayValue"
                          name={overlay.label}
                          stroke="var(--muted-foreground)"
                          strokeWidth={1.25}
                          strokeDasharray="4 3"
                          fill="none"
                          connectNulls={false}
                          dot={false}
                          activeDot={{ r: 3, strokeWidth: 0 }}
                          isAnimationActive={false}
                        />
                      )}
                    </>
                  ) : overlay ? (
                    <>
                      {/* value = 이동평균 (점선 회색) */}
                      <Area
                        type="monotone"
                        dataKey="value"
                        name="이동평균"
                        stroke="var(--muted-foreground)"
                        strokeWidth={1}
                        strokeDasharray="4 3"
                        fill="none"
                        dot={false}
                        activeDot={false}
                      />
                      {/* 지수: 평균 위 = 녹색, 아래 = 적색 */}
                      <Area
                        type="monotone"
                        dataKey="ovAbove"
                        name={overlay.label}
                        stroke="oklch(0.62 0.17 150)"
                        strokeWidth={1.6}
                        fill="none"
                        connectNulls={false}
                        dot={false}
                        activeDot={{ r: 3, strokeWidth: 0 }}
                        isAnimationActive={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="ovBelow"
                        name={overlay.label}
                        stroke="oklch(0.58 0.21 27)"
                        strokeWidth={1.6}
                        fill="none"
                        connectNulls={false}
                        dot={false}
                        activeDot={{ r: 3, strokeWidth: 0 }}
                        isAnimationActive={false}
                      />
                    </>
                  ) : showMa ? (
                    <>
                      {/* 원본선: MA20 ≥ MA60 = 녹색 / 아래 = 적색 */}
                      <Area
                        type="monotone"
                        dataKey="value"
                        name={selected?.valueLabel ?? "값"}
                        stroke="none"
                        fill="none"
                        dot={false}
                        activeDot={false}
                        isAnimationActive={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="maBase"
                        tooltipType="none"
                        stroke="var(--foreground)"
                        strokeWidth={1.4}
                        strokeOpacity={0.6}
                        fill="none"
                        connectNulls={false}
                        dot={false}
                        activeDot={false}
                        isAnimationActive={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="maGood"
                        tooltipType="none"
                        stroke="oklch(0.62 0.17 150)"
                        strokeWidth={1.6}
                        fill="none"
                        connectNulls={false}
                        dot={false}
                        activeDot={{ r: 3, strokeWidth: 0 }}
                        isAnimationActive={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="maBad"
                        tooltipType="none"
                        stroke="oklch(0.58 0.21 27)"
                        strokeWidth={1.6}
                        fill="none"
                        connectNulls={false}
                        dot={false}
                        activeDot={{ r: 3, strokeWidth: 0 }}
                        isAnimationActive={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="ma20"
                        name="MA20"
                        stroke="oklch(0.62 0.13 250)"
                        strokeWidth={1.1}
                        strokeDasharray="4 3"
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    </>
                  ) : (
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="var(--foreground)"
                      strokeWidth={selected ? 1.5 : 2}
                      strokeOpacity={selected ? 1 : 0.9}
                      // F&G 종합은 배경 채움 없이 선만 (조금 두껍게)
                      fill={showNorm || !selected ? "none" : "url(#fgFill)"}
                      dot={false}
                      activeDot={{ r: 3, strokeWidth: 0 }}
                    />
                  )}
                  {showNorm && (
                    <>
                      <ReferenceLine
                        yAxisId="norm"
                        y={50}
                        stroke="oklch(0.78 0.08 250)"
                        strokeWidth={1.25}
                        strokeDasharray="4 3"
                        strokeOpacity={0.85}
                        label={{
                          value: "정규화 50",
                          position: "insideLeft",
                          fontSize: 10,
                          fontWeight: 600,
                          fill: "oklch(0.78 0.08 250)",
                          dy: -10,
                        }}
                      />
                      <Line
                        yAxisId="norm"
                        type="monotone"
                        dataKey="normUp"
                        stroke="oklch(0.62 0.17 150)"
                        strokeWidth={1.4}
                        strokeDasharray="4 3"
                        dot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                        name="norm"
                      />
                      <Line
                        yAxisId="norm"
                        type="monotone"
                        dataKey="normDown"
                        stroke="oklch(0.58 0.21 27)"
                        strokeWidth={1.4}
                        strokeDasharray="4 3"
                        dot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                        name="norm"
                      />
                      {/* 정크본드: 급락(직전 대비 20p 이상) 지점에 빨간 세로 타원 */}
                      {dropStyle === "ellipse" && (
                        <Line
                          yAxisId="norm"
                          dataKey="dropMid"
                          stroke="none"
                          legendType="none"
                          tooltipType="none"
                          isAnimationActive={false}
                          connectNulls={false}
                          activeDot={false}
                          dot={(p: {
                            cx?: number;
                            cy?: number;
                            payload?: { dropMid?: number | null; dropSpan?: number };
                            yAxis?: { scale?: (v: number) => number };
                          }) => {
                            const { cx, cy, payload } = p;
                            if (cx == null || cy == null || payload?.dropMid == null)
                              return <g key="e" />;
                            const scale = p.yAxis?.scale;
                            const spanPx =
                              scale && payload.dropSpan
                                ? Math.abs(scale(0)! - scale(payload.dropSpan)!)
                                : 40;
                            return (
                              <ellipse
                                key={`${cx}-${cy}`}
                                cx={cx}
                                cy={cy}
                                rx={20}
                                ry={spanPx / 2 + 16}
                                fill="oklch(0.62 0.22 25)"
                                fillOpacity={0.07}
                                stroke="oklch(0.55 0.22 25)"
                                strokeWidth={1.75}
                              />
                            );
                          }}
                        />
                      )}
                    </>
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* 세부지표 — 한 줄, 클릭 시 위 차트에 원본 추이 */}
        <div className="grid grid-cols-2 gap-1.5 border-t pt-3 sm:grid-cols-4 lg:grid-cols-7">
          {fg.components.map((c) => {
            const active = c.key === selectedKey;
            const dir = componentScoreDir(c.key, c.history);
            return (
              <button
                key={c.key}
                onClick={() => setSelectedKey(active ? null : c.key)}
                title={`${c.label}\n최근 약 1개월 ${dir === 1 ? "상승(탐욕쪽)" : dir === -1 ? "하락(공포쪽)" : "보합"}`}
                className={cn(
                  "flex flex-col items-center gap-0.5 rounded-md border px-1.5 py-1.5 text-center transition-colors",
                  active
                    ? "border-primary bg-secondary"
                    : "border-border hover:bg-muted/50",
                )}
              >
                <span className="text-muted-foreground w-full truncate text-[10px] leading-tight">
                  {SHORT_COMPONENT[c.key] ?? c.label}
                </span>
                <span className="flex items-center gap-0.5">
                  <span
                    className="tnum text-sm font-semibold"
                    style={{ color: c.score != null ? fgColor(c.score) : undefined }}
                  >
                    {c.score ?? "-"}
                  </span>
                  <span
                    className={cn(
                      "text-[10px] leading-none",
                      dir === 1 && "text-up",
                      dir === -1 && "text-down",
                      dir === 0 && "text-muted-foreground",
                    )}
                  >
                    {dir === 1 ? "▲" : dir === -1 ? "▼" : "–"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-muted-foreground/80 text-[11px]">
          {fg.asOf} · {fg.source} · 세부지표 클릭 시 원본 값 추이 · 낮을수록 공포, 높을수록 탐욕
        </p>
      </CardContent>
      </Card>
    </div>
  );
}

// 나스닥 리베이스 오버레이를 숨길 지표
//  - DFEDTARU(기준금리): 첫 값이 ~0(제로금리기)이라 리베이스 시 바닥에 눌려 의미 없음
//  - M2SL(M2 통화량): 우상향 추세가 나스닥과 거의 겹쳐 비교 의미 적음
const HIDE_NASDAQ_OVERLAY = new Set(["DFEDTARU", "M2SL"]);

function IndicatorCard({ ind, nasdaq: nasdaqRaw }: { ind: Indicator; nasdaq: Indicator | null }) {
  const nasdaq = HIDE_NASDAQ_OVERLAY.has(ind.id) ? null : nasdaqRaw;
  // 나스닥을 같은 기간으로 정규화해 오버레이
  const merged = useMemo(() => {
    // 나스닥은 일간, 지표는 월간일 수 있어 날짜가 정확히 안 맞는다 →
    // 각 지표 시점에 대해 "그 날짜 이하의 가장 최근 나스닥 값"을 사용.
    const nSeries = [...(nasdaq?.series ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const nAsOf = (date: string): number | null => {
      let lo = 0;
      let hi = nSeries.length - 1;
      let ans: number | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (nSeries[mid].date <= date) {
          ans = nSeries[mid].value;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    };
    const first = ind.series[0]?.value ?? 1;
    const nFirst = ind.series[0] ? (nAsOf(ind.series[0].date) ?? nSeries[0]?.value ?? 1) : 1;
    return ind.series.map((p) => {
      const n = nAsOf(p.date);
      return {
        date: p.date,
        value: p.value,
        // 나스닥을 지표 첫 값 스케일로 리베이스
        nasdaq: n != null ? (n / nFirst) * first : null,
      };
    });
  }, [ind.series, nasdaq]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm leading-snug">{ind.name}</CardTitle>
          <UITooltip>
            <UITooltipTrigger asChild>
              <Badge
                variant="outline"
                className={cn("shrink-0 cursor-help gap-1", VERDICT_CLASS[ind.verdict])}
              >
                <DirIcon dir={ind.direction6m} />
                {VERDICT_LABEL[ind.verdict]}
              </Badge>
            </UITooltipTrigger>
            <UITooltipContent
              side="left"
              className="text-popover-foreground bg-popover max-w-none items-start border p-0 shadow-md"
            >
              <div className="space-y-1.5 p-2.5">
                <div className="text-[11px] leading-snug font-medium">
                  현재: {ind.verdictReason || VERDICT_LABEL[ind.verdict]}
                </div>
                {ind.guide.length > 0 && (
                  <table className="border-separate border-spacing-x-2 border-spacing-y-0.5 text-[11px]">
                    <tbody>
                      {ind.guide.map((g, i) => (
                        <tr key={i}>
                          <td className="whitespace-nowrap text-right opacity-80">{g.when}</td>
                          <td
                            className={cn(
                              "font-medium",
                              g.verdict === "positive" && "text-up",
                              g.verdict === "negative" && "text-down",
                              g.verdict === "neutral" && "opacity-70",
                            )}
                          >
                            {VERDICT_LABEL[g.verdict]}
                          </td>
                          <td className="opacity-70">{g.note ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </UITooltipContent>
          </UITooltip>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {(() => {
          const rateLike =
            ind.transform === "yoy" || ind.unit === "%" || ind.unit === "%p" || ind.unit === "% YoY";
          const digits = rateLike ? 2 : 0;
          const chgSuffix = rateLike ? "%p" : "%";
          return (
            <>
              <div className="flex items-baseline gap-2">
                <span className="tnum text-2xl font-semibold">
                  {ind.latest ? formatNumber(ind.latest.value, digits) : "-"}
                </span>
                <span className="text-muted-foreground text-xs">{ind.unit}</span>
                <span className="text-muted-foreground ml-auto text-xs">{ind.latest?.date ?? "데이터 없음"}</span>
              </div>
              <div className="text-muted-foreground flex gap-3 text-xs">
                <span>
                  6M{" "}
                  <b className={cn(ind.change6m != null && ind.change6m > 0 ? "text-up" : "text-down")}>
                    {ind.change6m != null
                      ? `${ind.change6m > 0 ? "+" : ""}${formatNumber(ind.change6m, 1)}${chgSuffix}`
                      : "-"}
                  </b>
                </span>
                <span>
                  12M{" "}
                  <b className={cn(ind.change12m != null && ind.change12m > 0 ? "text-up" : "text-down")}>
                    {ind.change12m != null
                      ? `${ind.change12m > 0 ? "+" : ""}${formatNumber(ind.change12m, 1)}${chgSuffix}`
                      : "-"}
                  </b>
                </span>
              </div>
            </>
          );
        })()}

        <div className="h-24">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={merged} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <XAxis dataKey="date" hide />
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <YAxis yAxisId="n" hide domain={["dataMin", "dataMax"]} />
              <Tooltip
                contentStyle={{ fontSize: 11, padding: "4px 8px" }}
                labelFormatter={(l) => String(l)}
                formatter={(v, name) => [
                  formatNumber(typeof v === "number" ? v : Number(v), 1),
                  name === "nasdaq" ? "나스닥(리베이스)" : ind.name,
                ]}
              />
              <Line
                type="monotone"
                dataKey="nasdaq"
                stroke="var(--muted-foreground)"
                strokeWidth={1}
                dot={false}
                strokeDasharray="3 3"
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--foreground)"
                strokeWidth={1.5}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <p className="text-muted-foreground text-xs leading-snug">{ind.verdictReason}</p>
        <p className="text-muted-foreground/80 text-[11px] leading-snug">{ind.note}</p>
      </CardContent>
    </Card>
  );
}
