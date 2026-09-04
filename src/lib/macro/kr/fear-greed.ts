import "server-only";
import { getKrFgHistory, type KrFgDailyDoc } from "@/lib/db/kr-fg";
import type { FearGreed } from "@/lib/macro/feargreed";

/**
 * 한국판 공포·탐욕 지수 — kr_fg_daily 히스토리에서 7개 컴포넌트를 산출·정규화·종합.
 * UI 재사용을 위해 CNN FearGreed 인터페이스와 동일 형태로 반환.
 */

const NORM_WINDOW = 252 * 3; // 정규화 창: 최근 3년

type Row = { date: string; value: number };
type Comp = {
  key: string;
  label: string;
  valueLabel: string;
  raw: (d: KrFgDailyDoc, i: number, all: KrFgDailyDoc[]) => number | null;
  /** raw 가 높을수록 탐욕이면 true */
  higherIsGreedy: boolean;
};

const sma = (arr: (number | null)[], i: number, p: number): number | null => {
  if (i < p - 1) return null;
  let s = 0;
  for (let k = i - p + 1; k <= i; k++) {
    const v = arr[k];
    if (v == null) return null;
    s += v;
  }
  return s / p;
};

const ret = (arr: (number | null)[], i: number, p: number): number | null => {
  if (i < p) return null;
  const a = arr[i];
  const b = arr[i - p];
  return a != null && b != null && b !== 0 ? (a - b) / b : null;
};

const COMPONENTS: Comp[] = [
  {
    key: "kr_momentum",
    label: "시장 모멘텀 (KOSPI vs 125일선)",
    valueLabel: "KOSPI − 125일 이동평균 (%)",
    higherIsGreedy: true,
    raw: (_d, i, all) => {
      const closes = all.map((x) => x.kospiClose);
      const m = sma(closes, i, 125);
      const c = closes[i];
      return m != null && c != null ? ((c - m) / m) * 100 : null;
    },
  },
  {
    key: "kr_strength",
    label: "주가 강도 (52주 신고가/신저가)",
    valueLabel: "(신고가 − 신저가) / 대상종목 (%)",
    higherIsGreedy: true,
    raw: (d) =>
      d.newHigh52 != null && d.newLow52 != null && d.totalWithHistory
        ? ((d.newHigh52 - d.newLow52) / d.totalWithHistory) * 100
        : null,
  },
  {
    key: "kr_breadth",
    label: "주가 폭 (등락 거래량)",
    valueLabel: "(상승 − 하락) 거래량 비율 (%)",
    higherIsGreedy: true,
    raw: (d) => {
      const u = d.upVolume ?? 0;
      const dn = d.downVolume ?? 0;
      return u + dn > 0 ? ((u - dn) / (u + dn)) * 100 : null;
    },
  },
  {
    key: "kr_vkospi",
    label: "변동성 (VKOSPI)",
    valueLabel: "코스피200 변동성지수",
    higherIsGreedy: false,
    raw: (d) => d.vkospi,
  },
  {
    key: "kr_safehaven",
    label: "안전자산 선호 (주식 − 채권 20일)",
    valueLabel: "KOSPI 20일 − 국채 20일 수익률차 (%p)",
    higherIsGreedy: true,
    raw: (_d, i, all) => {
      const closes = all.map((x) => x.kospiClose);
      const g10 = all.map((x) => x.gov10y);
      const stk = ret(closes, i, 20);
      if (stk == null) return null;
      // 채권 총수익 근사: −Δ수익률 × 듀레이션(≈8)
      const y = g10[i];
      const y0 = g10[i - 20];
      if (y == null || y0 == null) return null;
      const bond = -(y - y0) * 8;
      return stk * 100 - bond;
    },
  },
  {
    key: "kr_credit",
    label: "신용 스프레드 (BBB− − AA− 회사채)",
    valueLabel: "BBB− − AA− 회사채 3년 (%p) — CNN 정크·우량 비교와 동일",
    higherIsGreedy: false,
    raw: (d) => (d.corpBBB != null && d.corpAA != null ? d.corpBBB - d.corpAA : null),
  },
  {
    key: "kr_putcall",
    label: "풋/콜 옵션",
    valueLabel: "코스피200 옵션 풋/콜 거래량비",
    higherIsGreedy: false,
    raw: (d) => d.putCall,
  },
];

function ratingKo(score: number): string {
  if (score < 25) return "극도의 공포";
  if (score < 45) return "공포";
  if (score <= 55) return "중립";
  if (score <= 75) return "탐욕";
  return "극도의 탐욕";
}
function ratingEn(score: number): string {
  if (score < 25) return "extreme fear";
  if (score < 45) return "fear";
  if (score <= 55) return "neutral";
  if (score <= 75) return "greed";
  return "extreme greed";
}

/** 시계열을 최근 창 min-max로 0~100 정규화 (invert 옵션) */
function normalize(series: Row[], invert: boolean): Row[] {
  const win = series.slice(-NORM_WINDOW);
  const vals = win.map((r) => r.value).filter(Number.isFinite);
  if (vals.length < 10) return [];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const range = hi - lo || 1;
  return series.map((r) => {
    let s = ((r.value - lo) / range) * 100;
    s = Math.max(0, Math.min(100, s));
    return { date: r.date, value: Math.round((invert ? 100 - s : s) * 10) / 10 };
  });
}

export async function getKrFearGreed(): Promise<
  (FearGreed & { ready: boolean; componentsReady: number }) | null
> {
  const all = await getKrFgHistory().catch(() => []);
  if (all.length < 5) return null;

  const compScored = COMPONENTS.map((c) => {
    const raw: Row[] = [];
    all.forEach((d, i) => {
      const v = c.raw(d, i, all);
      if (v != null && Number.isFinite(v)) raw.push({ date: d._id, value: Math.round(v * 1000) / 1000 });
    });
    const scored = normalize(raw, !c.higherIsGreedy);
    return { c, raw, scored };
  });

  // 종합 = 각 컴포넌트 정규화 점수 평균 (해당일 사용 가능한 것만)
  const byDate = new Map<string, number[]>();
  for (const { scored } of compScored) {
    for (const r of scored) {
      const arr = byDate.get(r.date) ?? [];
      arr.push(r.value);
      byDate.set(r.date, arr);
    }
  }
  const history: Row[] = [...byDate.entries()]
    .map(([date, arr]) => ({ date, value: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 }))
    .filter((r) => (byDate.get(r.date)?.length ?? 0) >= 3)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (history.length === 0) return null;

  const latest = history[history.length - 1];
  const at = (daysBack: number) => history[Math.max(0, history.length - 1 - daysBack)]?.value ?? latest.value;
  const componentsReady = compScored.filter((x) => x.scored.length > 0).length;

  return {
    score: Math.round(latest.value * 10) / 10,
    rating: ratingEn(latest.value),
    ratingKo: ratingKo(latest.value),
    asOf: latest.date,
    prevClose: Math.round(at(1) * 10) / 10,
    prev1w: Math.round(at(5) * 10) / 10,
    prev1m: Math.round(at(21) * 10) / 10,
    prev1y: Math.round(at(252) * 10) / 10,
    history: history.slice(-180),
    components: compScored.map(({ c, raw, scored }) => ({
      key: c.key,
      label: c.label,
      valueLabel: c.valueLabel,
      score: scored.length ? Math.round(scored[scored.length - 1].value * 10) / 10 : null,
      rating: scored.length ? ratingEn(scored[scored.length - 1].value) : null,
      history: raw.slice(-180),
    })),
    source: "KRX · 한국은행 ECOS (자체 산출)",
    deepLink: "https://data.krx.co.kr",
    ready: componentsReady >= 5,
    componentsReady,
  };
}
