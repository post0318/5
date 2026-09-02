"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowDownRight, ArrowRight, ArrowUpRight, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/query";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type Verdict = "positive" | "negative" | "neutral";
type Direction = "up" | "down" | "flat";

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
  components: { label: string; score: number | null; rating: string | null }[];
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

const FG_SEGMENTS = [
  { from: 0, to: 25, color: "oklch(0.58 0.20 25)", label: "극도의 공포" },
  { from: 25, to: 45, color: "oklch(0.72 0.16 55)", label: "공포" },
  { from: 45, to: 55, color: "oklch(0.80 0.12 95)", label: "중립" },
  { from: 55, to: 75, color: "oklch(0.75 0.15 150)", label: "탐욕" },
  { from: 75, to: 100, color: "oklch(0.62 0.17 155)", label: "극도의 탐욕" },
] as const;

function fgColor(score: number): string {
  return (FG_SEGMENTS.find((s) => score < s.to) ?? FG_SEGMENTS[FG_SEGMENTS.length - 1]).color;
}

/** CNN 스타일 반원 게이지 */
function FearGreedGauge({ score }: { score: number }) {
  const CX = 100;
  const CY = 95;
  const R = 74;
  const SW = 16;
  const clamped = Math.min(100, Math.max(0, score));
  const needleAngle = -90 + clamped * 1.8;

  return (
    <svg viewBox="0 0 200 118" className="w-full max-w-[280px]" role="img" aria-label={`Fear & Greed ${score}`}>
      {/* 배경 트랙 */}
      <circle
        cx={CX}
        cy={CY}
        r={R}
        pathLength={100}
        fill="none"
        stroke="var(--muted)"
        strokeWidth={SW}
        strokeDasharray="50 100"
        strokeLinecap="butt"
        transform={`rotate(180 ${CX} ${CY})`}
      />
      {/* 색상 세그먼트 */}
      {FG_SEGMENTS.map((s) => (
        <circle
          key={s.from}
          cx={CX}
          cy={CY}
          r={R}
          pathLength={100}
          fill="none"
          stroke={s.color}
          strokeWidth={SW}
          strokeDasharray={`${(s.to - s.from) / 2 - 0.6} 100`}
          strokeDashoffset={-(s.from / 2)}
          strokeLinecap="butt"
          transform={`rotate(180 ${CX} ${CY})`}
        />
      ))}
      {/* 눈금 */}
      {[0, 25, 50, 75, 100].map((t) => {
        const a = ((-90 + t * 1.8) * Math.PI) / 180;
        const x1 = CX + (R - SW / 2 - 2) * Math.sin(a);
        const y1 = CY - (R - SW / 2 - 2) * Math.cos(a);
        const x2 = CX + (R + SW / 2 + 2) * Math.sin(a);
        const y2 = CY - (R + SW / 2 + 2) * Math.cos(a);
        return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--background)" strokeWidth={2} />;
      })}
      {/* 바늘 */}
      <g transform={`rotate(${needleAngle} ${CX} ${CY})`}>
        <polygon
          points={`${CX - 5},${CY} ${CX + 5},${CY} ${CX},${CY - R - 4}`}
          fill="var(--foreground)"
        />
        <circle cx={CX} cy={CY} r={7} fill="var(--foreground)" />
        <circle cx={CX} cy={CY} r={3} fill="var(--background)" />
      </g>
      {/* 중앙 값 */}
      <text
        x={CX}
        y={CY - 16}
        textAnchor="middle"
        fontSize="26"
        fontWeight="700"
        fill={fgColor(score)}
      >
        {score}
      </text>
    </svg>
  );
}

function FearGreedCard({ fg }: { fg: FearGreed }) {
  const trend = (label: string, val: number) => (
    <span className="text-muted-foreground">
      {label}{" "}
      <b className={cn(val > fg.score ? "text-down" : val < fg.score ? "text-up" : "")}>{val}</b>
    </span>
  );
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">CNN Fear &amp; Greed — 시장 심리·위험</CardTitle>
          <a
            href={fg.deepLink}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
          >
            CNN 원본
          </a>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-6">
          <FearGreedGauge score={fg.score} />
          <div className="space-y-2">
            <div className="text-lg font-semibold" style={{ color: fgColor(fg.score) }}>
              {fg.ratingKo}
            </div>
            <div className="flex flex-col gap-1 text-xs">
              {trend("전일", fg.prevClose)}
              {trend("1주 전", fg.prev1w)}
              {trend("1개월 전", fg.prev1m)}
              {trend("1년 전", fg.prev1y)}
            </div>
          </div>
        </div>

        <div className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
          {fg.components
            .filter((c) => c.score != null)
            .map((c) => (
              <div key={c.label} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground truncate">{c.label}</span>
                <span className="tnum shrink-0" style={{ color: fgColor(c.score!) }}>
                  {c.score}
                </span>
              </div>
            ))}
        </div>
        <p className="text-muted-foreground/80 text-[11px]">
          {fg.asOf} · {fg.source} · 낮을수록 공포(저점 매수 관점), 높을수록 탐욕(과열 경계)
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
