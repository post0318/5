import "server-only";
import { fetchText } from "@/lib/markets/http";
import { AdapterError } from "@/lib/markets/types";

/**
 * FRED (세인트루이스 연준) 시계열 — 거시 지표.
 * 공개 CSV 엔드포인트 사용 (키 불필요). 필요 시 Nasdaq Data Link(FRED/*) 폴백.
 */

export type SignalDirection = "up" | "down" | "flat";
export type SignalVerdict = "positive" | "negative" | "neutral";

export interface MacroPoint {
  date: string;
  value: number;
}

export type MacroCategory = "market" | "leading" | "core";

export interface MacroIndicator {
  id: string;
  name: string;
  category: MacroCategory;
  unit: string;
  /** FRED 시리즈 설명 */
  note: string;
  /** 값이 오르는 게 경기에 긍정이면 "up", 내리는 게 긍정이면 "down", 판단 보류면 "none" */
  goodDirection: "up" | "down" | "none";
  frequency: "daily" | "weekly" | "monthly" | "quarterly";
  /** 표시 변환: 원계열 / 전년동기대비 %(YoY) */
  transform: "level" | "yoy";
  latest: MacroPoint | null;
  change6m: number | null;
  change12m: number | null;
  direction6m: SignalDirection;
  verdict: SignalVerdict;
  verdictReason: string;
  series: MacroPoint[];
}

interface IndicatorSpec {
  id: string;
  name: string;
  category: MacroCategory;
  unit: string;
  note: string;
  goodDirection: "up" | "down" | "none";
  frequency: "daily" | "weekly" | "monthly" | "quarterly";
  transform?: "level" | "yoy";
  /** 레벨 기반 추가 해석 (선택) */
  levelVerdict?: (latest: number, dir: SignalDirection) => { verdict: SignalVerdict; reason: string } | null;
}

const SPECS: IndicatorSpec[] = [
  {
    id: "NASDAQCOM",
    name: "나스닥 종합지수",
    category: "market",
    unit: "pt",
    note: "미국 증시 대표 지수. 다른 지표와 겹쳐 본다.",
    goodDirection: "up",
    frequency: "daily",
  },
  // ── 경기 선행지표 ──────────────────────────────────────────────
  {
    id: "ICSA",
    name: "주간 신규 실업수당 청구",
    category: "leading",
    unit: "건",
    note: "경기 악화 시 후행, 회복 시 선행. 낮을수록 고용 견조.",
    goodDirection: "down",
    frequency: "weekly",
  },
  {
    id: "UMCSENT",
    name: "미시간대 소비자심리지수",
    category: "leading",
    unit: "idx",
    note: "100 기준. 침체 전 먼저 하락하는 경향(선행).",
    goodDirection: "up",
    frequency: "monthly",
    levelVerdict: (v, dir) => {
      if (v < 70) return { verdict: "negative", reason: `${v} — 위축 국면(70 미만), 소비 둔화 신호` };
      if (v < 85) return { verdict: dir === "up" ? "neutral" : "negative", reason: `${v} — 중립 이하(85 미만)` };
      return { verdict: dir === "down" ? "neutral" : "positive", reason: `${v} — 양호(85 이상)` };
    },
  },
  {
    id: "HSN1F",
    name: "신규 단독주택 판매",
    category: "leading",
    unit: "천호",
    note: "주택시장 활력. 침체 전 먼저 꺾이는 경향(선행).",
    goodDirection: "up",
    frequency: "monthly",
  },
  {
    id: "M2SL",
    name: "M2 통화량",
    category: "leading",
    unit: "$B",
    note: "시중 유동성. 증가는 완화적, 급감은 긴축 위험.",
    goodDirection: "up",
    frequency: "monthly",
  },
  {
    id: "BAMLH0A0HYM2",
    name: "하이일드 채권 스프레드 (OAS)",
    category: "leading",
    unit: "%p",
    note: "신용 위험 프리미엄. 낮으면 위험선호, 급등은 스트레스 신호.",
    goodDirection: "down",
    frequency: "daily",
    levelVerdict: (v, dir) => {
      if (v >= 5) return { verdict: "negative", reason: `${v}%p — 스트레스 구간(5%p 이상)` };
      if (v >= 4) return { verdict: dir === "up" ? "negative" : "neutral", reason: `${v}%p — 경계` };
      return { verdict: "positive", reason: `${v}%p — 안정(4%p 미만)` };
    },
  },
  {
    id: "T10Y2Y",
    name: "장단기 금리차 (10Y-2Y)",
    category: "leading",
    unit: "%p",
    note: "역전(음수)은 대표적 침체 선행 신호. 재정상화(가팔라짐)는 회복 신호.",
    goodDirection: "up",
    frequency: "daily",
    levelVerdict: (v, dir) => {
      if (v < 0) return { verdict: "negative", reason: `${v.toFixed(2)}%p — 수익률 곡선 역전(침체 선행)` };
      if (v < 0.3) return { verdict: dir === "down" ? "negative" : "neutral", reason: `${v.toFixed(2)}%p — 매우 평탄` };
      if (v < 0.8) return { verdict: "neutral", reason: `${v.toFixed(2)}%p — 완만한 우상향` };
      return { verdict: "positive", reason: `${v.toFixed(2)}%p — 정상(우상향)` };
    },
  },
  // ── 핵심 거시지표 ──────────────────────────────────────────────
  {
    id: "FEDFUNDS",
    name: "기준금리 (실효 연방기금금리)",
    category: "core",
    unit: "%",
    note: "통화정책 스탠스. 인하는 완화(성장 우호), 인상은 긴축.",
    goodDirection: "down",
    frequency: "monthly",
  },
  {
    id: "CPIAUCSL",
    name: "소비자물가 (CPI, 전년비)",
    category: "core",
    unit: "% YoY",
    note: "헤드라인 인플레이션. 연준 목표 2% 부근이 이상적.",
    goodDirection: "down",
    frequency: "monthly",
    transform: "yoy",
    levelVerdict: (v) => {
      if (v > 4) return { verdict: "negative", reason: `${v.toFixed(1)}% — 고물가(4% 초과), 긴축 압력` };
      if (v > 3) return { verdict: "negative", reason: `${v.toFixed(1)}% — 목표(2%) 상회, 물가 부담` };
      if (v > 2.5) return { verdict: "neutral", reason: `${v.toFixed(1)}% — 목표 소폭 상회` };
      if (v < 1) return { verdict: "neutral", reason: `${v.toFixed(1)}% — 저물가(디플레 경계)` };
      return { verdict: "positive", reason: `${v.toFixed(1)}% — 목표(2%) 부근` };
    },
  },
  {
    id: "GDP",
    name: "명목 GDP (전년비)",
    category: "core",
    unit: "% YoY",
    note: "미국 명목 GDP(계절조정 연율)의 전년동기 대비 성장률.",
    goodDirection: "up",
    frequency: "quarterly",
    transform: "yoy",
    levelVerdict: (v) => {
      if (v < 0) return { verdict: "negative", reason: `${v.toFixed(1)}% — 역성장` };
      if (v < 3) return { verdict: "neutral", reason: `${v.toFixed(1)}% — 저성장` };
      return { verdict: "positive", reason: `${v.toFixed(1)}% — 성장 지속` };
    },
  },
  {
    id: "DGS10",
    name: "미국채 10년물 금리",
    category: "core",
    unit: "%",
    note: "장기 금리 벤치마크. 자산 밸류에이션·모기지 금리에 직결.",
    goodDirection: "none",
    frequency: "daily",
  },
  {
    id: "UNRATE",
    name: "실업률",
    category: "core",
    unit: "%",
    note: "침체에 후행, 회복에 동행. 저점에서 반등 시작이 경고(삼의 법칙).",
    goodDirection: "down",
    frequency: "monthly",
  },
];

async function fetchSeries(id: string): Promise<MacroPoint[]> {
  const csv = await fetchText(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2015-01-01`,
    { headers: { "user-agent": "Mozilla/5.0", accept: "text/csv" }, revalidate: 60 * 60 * 12 },
  );
  const lines = csv.trim().split(/\r?\n/);
  const out: MacroPoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, raw] = lines[i].split(",");
    if (!raw || raw === ".") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) out.push({ date, value });
  }
  if (out.length === 0) throw new AdapterError(`FRED 시리즈 비어있음: ${id}`, { status: 502 });
  return out;
}

/**
 * 특정 FRED 시리즈의 장기 평균 (지정 시작일부터 현재까지).
 * VIX 역사적 평균 등에 사용 — 매일 새 데이터가 반영되어 값이 조금씩 변함.
 */
export async function getSeriesLongTermMean(
  id: string,
  since = "1990-01-01",
): Promise<{ mean: number; n: number; latest: MacroPoint | null } | null> {
  try {
    const csv = await fetchText(
      `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${since}`,
      { headers: { "user-agent": "Mozilla/5.0", accept: "text/csv" }, revalidate: 60 * 60 * 24 },
    );
    const lines = csv.trim().split(/\r?\n/);
    const vals: number[] = [];
    let latest: MacroPoint | null = null;
    for (let i = 1; i < lines.length; i++) {
      const [date, raw] = lines[i].split(",");
      if (!raw || raw === ".") continue;
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      vals.push(v);
      latest = { date, value: v };
    }
    if (vals.length === 0) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { mean: Math.round(mean * 100) / 100, n: vals.length, latest };
  } catch {
    return null;
  }
}

/** 원계열 → 전년동기대비 % 계열 */
function toYoY(series: MacroPoint[]): MacroPoint[] {
  const out: MacroPoint[] = [];
  for (let i = 0; i < series.length; i++) {
    const cur = series[i];
    const target = new Date(cur.date);
    target.setFullYear(target.getFullYear() - 1);
    const iso = target.toISOString().slice(0, 10);
    // 1년 전 시점 이하의 가장 최근 값
    let base: MacroPoint | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (series[j].date <= iso) {
        base = series[j];
        break;
      }
    }
    if (base && base.value !== 0) {
      out.push({ date: cur.date, value: ((cur.value - base.value) / Math.abs(base.value)) * 100 });
    }
  }
  return out;
}

function valueAsOfMonthsAgo(series: MacroPoint[], months: number): MacroPoint | null {
  const last = series.at(-1);
  if (!last) return null;
  const cutoff = new Date(last.date);
  cutoff.setMonth(cutoff.getMonth() - months);
  const iso = cutoff.toISOString().slice(0, 10);
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].date <= iso) return series[i];
  }
  return series[0];
}

function pct(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

function buildIndicator(spec: IndicatorSpec, rawSeries: MacroPoint[]): MacroIndicator {
  const transform = spec.transform ?? "level";
  const series = transform === "yoy" ? toYoY(rawSeries) : rawSeries;

  const latest = series.at(-1) ?? null;
  const p6 = valueAsOfMonthsAgo(series, 6);
  const p12 = valueAsOfMonthsAgo(series, 12);
  // YoY·금리 계열은 이미 %라 절대 변화(%p), 그 외는 % 변화
  const isRateLike = transform === "yoy" || spec.unit === "%" || spec.unit === "%p";
  const diff = (a: number, b: number) => (isRateLike ? a - b : pct(a, b) ?? 0);
  const change6m = latest && p6 ? diff(latest.value, p6.value) : null;
  const change12m = latest && p12 ? diff(latest.value, p12.value) : null;

  const threshold = isRateLike ? 0.3 : spec.frequency === "daily" ? 1.5 : 1;
  const direction6m: SignalDirection =
    change6m == null || Math.abs(change6m) < threshold
      ? "flat"
      : change6m > 0
        ? "up"
        : "down";

  let verdict: SignalVerdict = "neutral";
  let verdictReason = "";
  if (spec.levelVerdict && latest) {
    const lv = spec.levelVerdict(latest.value, direction6m);
    if (lv) {
      verdict = lv.verdict;
      verdictReason = lv.reason;
    }
  }
  if (!verdictReason) {
    if (spec.goodDirection === "none") {
      verdict = "neutral";
      verdictReason =
        direction6m === "flat"
          ? "최근 6개월 큰 변화 없음"
          : `6개월 ${direction6m === "up" ? "상승" : "하락"} (참고 지표)`;
    } else if (direction6m === "flat") {
      verdict = "neutral";
      verdictReason = "최근 6개월 큰 변화 없음";
    } else {
      const good = direction6m === spec.goodDirection;
      verdict = good ? "positive" : "negative";
      verdictReason = `6개월 ${direction6m === "up" ? "상승" : "하락"} → 경기 ${good ? "긍정" : "부정"} 신호`;
    }
  }

  return {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    unit: spec.unit,
    note: spec.note,
    goodDirection: spec.goodDirection,
    frequency: spec.frequency,
    transform,
    latest,
    change6m,
    change12m,
    direction6m,
    verdict,
    verdictReason,
    series: series.slice(spec.frequency === "daily" ? -260 : -60),
  };
}

export interface MacroDashboard {
  asOf: string;
  indicators: MacroIndicator[];
  summary: { positive: number; negative: number; neutral: number };
}

export async function getMacroDashboard(): Promise<MacroDashboard> {
  const results = await Promise.all(
    SPECS.map(async (spec) => {
      try {
        const series = await fetchSeries(spec.id);
        return buildIndicator(spec, series);
      } catch {
        return buildIndicator(spec, []);
      }
    }),
  );

  // 방향성 있는(goodDirection !== none) 지표만 점수화
  const scored = results.filter(
    (r) => r.category !== "market" && r.goodDirection !== "none" && r.latest,
  );
  const summary = {
    positive: scored.filter((r) => r.verdict === "positive").length,
    negative: scored.filter((r) => r.verdict === "negative").length,
    neutral: scored.filter((r) => r.verdict === "neutral").length,
  };

  const nasdaq = results.find((r) => r.id === "NASDAQCOM");
  return {
    asOf: nasdaq?.latest?.date ?? results.find((r) => r.latest)?.latest?.date ?? new Date().toISOString().slice(0, 10),
    indicators: results,
    summary,
  };
}
