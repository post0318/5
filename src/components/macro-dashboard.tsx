"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  CartesianGrid,
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
  series: { date: string; value: number }[];
}
interface IndexQuote {
  key: string;
  name: string;
  region: "kr" | "us" | "jp";
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
  }[];
  source: string;
  deepLink: string;
}
interface Dashboard {
  asOf: string;
  indicators: Indicator[];
  summary: { positive: number; negative: number; neutral: number };
  indices: IndexQuote[];
  fearGreed: FearGreed | null;
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

function DirIcon({ dir }: { dir: Direction }) {
  const I = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : ArrowRight;
  return <I className="size-3.5" />;
}

export function MacroDashboard() {
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">거시경제 · 경기 선행지표</h1>
          <p className="text-muted-foreground text-sm">
            FRED 기준 · {q.data?.asOf ?? "-"} · 나스닥 종합과 비교
          </p>
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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {q.data.indices.map((ix) => (
            <div key={ix.key} className="border-border rounded-lg border p-3">
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
            </div>
          ))}
        </div>
      )}

      {q.data && (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 text-sm">
              <span className="font-medium">종합 신호</span>
              <span className="text-up">긍정 {q.data.summary.positive}</span>
              <span className="text-down">부정 {q.data.summary.negative}</span>
              <span className="text-muted-foreground">중립 {q.data.summary.neutral}</span>
              <span className="text-muted-foreground">
                (나스닥 6M{" "}
                {nasdaq?.change6m != null
                  ? `${nasdaq.change6m > 0 ? "+" : ""}${formatNumber(nasdaq.change6m, 1)}%`
                  : "-"}
                )
              </span>
              <span className="text-muted-foreground ml-auto text-xs">
                지표 다수가 긍정이면 확장 국면, 스프레드·심리가 악화되면 후퇴 경계
              </span>
            </CardContent>
          </Card>

          {q.data.fearGreed && <FearGreedCard fg={q.data.fearGreed} />}

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">핵심 거시지표</h2>
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
};

function FearGreedCard({ fg }: { fg: FearGreed }) {
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
  };
  const yStep = selected ? stepByKey[selected.key] : undefined;
  const yAxis = useMemo(() => {
    if (!yStep || !selected) return null;
    const vals = selected.history.map((d) => d.value).filter(Number.isFinite);
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
  }, [selected, yStep]);

  // 기준선 대비 위/아래를 분리해 색을 다르게 칠하는 지표 설정
  const DIVERGING_CFG: Record<
    string,
    {
      threshold: number;
      aboveIsBad: boolean;
      aboveLabel?: string;
      belowLabel?: string;
      refLabel?: string;
      /** Y축 눈금 간격 */
      tickStep?: number;
      /** 도메인 경계 스냅 단위 */
      domainSnap?: number;
    }
  > = {
    safe_haven_demand: {
      threshold: 0,
      aboveIsBad: false,
      aboveLabel: "▲ 주식성과가 채권을 능가",
      belowLabel: "▼ 채권성과가 주식을 능가",
    },
    market_volatility_vix: {
      threshold: 19.5, // VIX 장기(1990~) 평균 ≈ 19.5
      aboveIsBad: true,
      aboveLabel: "▲ 역사적 평균 상회 · 변동성 확대",
      belowLabel: "▼ 역사적 평균 하회 · 안정",
      refLabel: "역사적 평균 19.50",
      tickStep: 5, // 라벨은 5 단위
      domainSnap: 5,
    },
  };
  const divCfg = selected ? DIVERGING_CFG[selected.key] : undefined;

  // 기준선 기준으로 위/아래 분리한 면적 데이터
  const divergingData = useMemo(
    () =>
      divCfg
        ? chartData.map((d) => ({
            ...d,
            above: Math.max(d.value, divCfg.threshold),
            below: Math.min(d.value, divCfg.threshold),
          }))
        : chartData,
    [divCfg, chartData],
  );

  // 다이버징 차트 Y축 (도메인 + 눈금). 데이터 + 기준선 포함.
  const divAxis = useMemo(() => {
    if (!divCfg) return null;
    const vals = chartData.map((d) => d.value).filter(Number.isFinite);
    if (!vals.length) return null;
    const rawLo = Math.min(...vals, divCfg.threshold);
    const rawHi = Math.max(...vals, divCfg.threshold);
    const snap = divCfg.domainSnap;
    let lo: number, hi: number;
    if (snap) {
      lo = Math.floor(rawLo / snap) * snap;
      hi = Math.ceil(rawHi / snap) * snap;
    } else {
      const pad = (rawHi - rawLo) * 0.1 || 1;
      lo = Math.round((rawLo - pad) * 100) / 100;
      hi = Math.round((rawHi + pad) * 100) / 100;
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
  }, [divCfg, chartData]);
  const divDomain = divAxis?.domain ?? null;

  // 세로 눈금 — F&G 종합은 월 단위, 세부지표는 분기(3개월) 단위
  const gridTicks = useMemo(() => {
    const seen = new Set<string>();
    const ticks: string[] = [];
    for (const d of chartData) {
      const [y, m] = d.date.split("-").map(Number);
      const bucket = selected ? `${y}-${Math.floor((m - 1) / 3)}` : `${y}-${m}`;
      if (!seen.has(bucket)) {
        seen.add(bucket);
        ticks.push(d.date);
      }
    }
    return ticks;
  }, [chartData, selected]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          <a
            href={fg.deepLink}
            target="_blank"
            rel="noreferrer"
            className="hover:text-primary inline-flex items-center gap-1 underline-offset-2 hover:underline"
          >
            CNN Fear &amp; Greed
            <ExternalLink className="size-3" />
          </a>
          <span className="text-muted-foreground font-normal"> — 시장 심리·위험</span>
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
              <div className="text-muted-foreground text-[11px]">{selected.valueLabel} · 원본 값</div>
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
                        stroke="var(--muted-foreground)"
                        strokeWidth={1}
                        strokeDasharray="4 3"
                        strokeOpacity={0.7}
                        label={
                          divCfg.refLabel
                            ? {
                                value: divCfg.refLabel,
                                position: "insideLeft",
                                fontSize: 10,
                                fontWeight: 600,
                                fill: "var(--foreground)",
                                dy: -5,
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
                      divAxis?.domain ?? (yAxis ? yAxis.domain : selected ? ["auto", "auto"] : [0, 100])
                    }
                    ticks={
                      divAxis
                        ? divAxis.ticks
                        : yAxis
                          ? yAxis.ticks
                          : selected
                            ? undefined
                            : [0, 25, 50, 75, 100]
                    }
                    tickFormatter={yAxis || divAxis ? (v: number) => v.toFixed(2) : fmtVal}
                    allowDecimals
                  />
                  <Tooltip
                    {...TOOLTIP_STYLE}
                    formatter={(v) => [fmtVal(v as number), selected ? selected.valueLabel : "F&G"]}
                  />
                  {divCfg ? (
                    <>
                      <Area
                        type="monotone"
                        dataKey="above"
                        baseValue={divCfg.threshold}
                        isAnimationActive={false}
                        tooltipType="none"
                        stroke="none"
                        fill={divCfg.aboveIsBad ? "oklch(0.58 0.21 27)" : "oklch(0.70 0.18 150)"}
                        fillOpacity={0.13}
                        dot={false}
                        activeDot={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="below"
                        baseValue={divCfg.threshold}
                        isAnimationActive={false}
                        tooltipType="none"
                        stroke="none"
                        fill={divCfg.aboveIsBad ? "oklch(0.70 0.18 150)" : "oklch(0.58 0.21 27)"}
                        fillOpacity={0.13}
                        dot={false}
                        activeDot={false}
                      />
                      <Area
                        type="monotone"
                        dataKey="value"
                        stroke="var(--foreground)"
                        strokeWidth={1}
                        strokeOpacity={0.7}
                        fill="none"
                        dot={false}
                        activeDot={{ r: 3, strokeWidth: 0 }}
                      />
                    </>
                  ) : (
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="var(--foreground)"
                      strokeWidth={1}
                        strokeOpacity={0.7}
                      fill="url(#fgFill)"
                      dot={false}
                      activeDot={{ r: 3, strokeWidth: 0 }}
                    />
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
            return (
              <button
                key={c.key}
                onClick={() => setSelectedKey(active ? null : c.key)}
                title={c.label}
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
                <span
                  className="tnum text-sm font-semibold"
                  style={{ color: c.score != null ? fgColor(c.score) : undefined }}
                >
                  {c.score ?? "-"}
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
  );
}

function IndicatorCard({ ind, nasdaq }: { ind: Indicator; nasdaq: Indicator | null }) {
  // 나스닥을 같은 기간으로 정규화해 오버레이
  const merged = useMemo(() => {
    const nMap = new Map(nasdaq?.series.map((p) => [p.date, p.value]) ?? []);
    const first = ind.series[0]?.value ?? 1;
    const nFirstDate = ind.series[0]?.date;
    const nFirst = nFirstDate ? (nMap.get(nFirstDate) ?? nasdaq?.series[0]?.value ?? 1) : 1;
    return ind.series.map((p) => ({
      date: p.date,
      value: p.value,
      // 나스닥을 지표 첫 값 스케일로 리베이스
      nasdaq: nMap.has(p.date) ? (nMap.get(p.date)! / nFirst) * first : null,
    }));
  }, [ind.series, nasdaq]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm leading-snug">{ind.name}</CardTitle>
          <Badge variant="outline" className={cn("shrink-0 gap-1", VERDICT_CLASS[ind.verdict])}>
            <DirIcon dir={ind.direction6m} />
            {VERDICT_LABEL[ind.verdict]}
          </Badge>
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
