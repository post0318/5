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
  /** 전체 히스토리 → 컴포넌트 원시 시계열 (null = 해당일 산출 불가) */
  series: (all: KrFgDailyDoc[]) => (number | null)[];
  /** 원시값이 높을수록 탐욕이면 true */
  higherIsGreedy: boolean;
};

/** 이동평균(단순). i < p-1 이거나 창에 null 있으면 null */
function smaSeries(arr: (number | null)[], p: number): (number | null)[] {
  return arr.map((_, i) => {
    if (i < p - 1) return null;
    let s = 0;
    for (let k = i - p + 1; k <= i; k++) {
      const v = arr[k];
      if (v == null) return null;
      s += v;
    }
    return s / p;
  });
}

/** 지수이동평균 (alpha 지정). null 은 이전값 유지, 시드 전엔 null */
function emaSeries(arr: (number | null)[], alpha: number): (number | null)[] {
  const out: (number | null)[] = [];
  let prev: number | null = null;
  for (const v of arr) {
    if (v == null) {
      out.push(prev);
      continue;
    }
    prev = prev == null ? v : alpha * v + (1 - alpha) * prev;
    out.push(prev);
  }
  return out;
}

const COMPONENTS: Comp[] = [
  {
    key: "kr_momentum",
    label: "시장 모멘텀 (KOSPI vs 125일선)",
    valueLabel: "KOSPI − 125일 이동평균 이격도 (%)",
    higherIsGreedy: true,
    series: (all) => {
      const closes = all.map((x) => x.kospiClose);
      const ma = smaSeries(closes, 125);
      return closes.map((c, i) => {
        const m = ma[i];
        return c != null && m != null ? ((c - m) / m) * 100 : null;
      });
    },
  },
  {
    key: "kr_strength",
    label: "주가 강도 (52주 신고가/신저가)",
    valueLabel: "(신고가 − 신저가) / 대상종목 (%)",
    higherIsGreedy: true,
    series: (all) =>
      all.map((d) =>
        d.newHigh52 != null && d.newLow52 != null && d.totalWithHistory
          ? ((d.newHigh52 - d.newLow52) / d.totalWithHistory) * 100
          : null,
      ),
  },
  {
    key: "kr_breadth",
    label: "주가 폭 (McClellan Volume Summation Index)",
    valueLabel: "AV−DV의 McClellan 오실레이터 누적 (CNN과 동일 산식)",
    higherIsGreedy: true,
    series: (all) => {
      // (AV−DV)/(AV+DV) ×1000 — 규모 정규화된 순거래량 (RANV: 시장 규모 변동에 견고)
      const rn = all.map((d) => {
        const u = d.upVolume ?? null;
        const dn = d.downVolume ?? null;
        return u != null && dn != null && u + dn > 0 ? ((u - dn) / (u + dn)) * 1000 : null;
      });
      const t10 = emaSeries(rn, 0.1); // ≈ EMA19
      const t5 = emaSeries(rn, 0.05); // ≈ EMA39
      const osc = rn.map((_, i) =>
        t10[i] != null && t5[i] != null ? (t10[i] as number) - (t5[i] as number) : null,
      );
      // Summation Index = 오실레이터 누적합
      let sum = 0;
      let started = false;
      return osc.map((o) => {
        if (o == null) return started ? sum : null;
        sum += o;
        started = true;
        return sum;
      });
    },
  },
  {
    key: "kr_vkospi",
    label: "변동성 (KOSPI 실현변동성, 50일선 대비)",
    valueLabel: "20일 실현변동성(연율) ÷ 50일 이동평균 — CNN VIX/MA50 산식 대응",
    higherIsGreedy: false,
    series: (all) => {
      // VKOSPI 히스토리는 KRX API가 최근분만 제공 → KOSPI 종가로 실현변동성 산출.
      const closes = all.map((x) => x.kospiClose);
      const rets = closes.map((c, i) => {
        const p = closes[i - 1];
        return c != null && p != null && p !== 0 ? Math.log(c / p) : null;
      });
      const rv: (number | null)[] = closes.map((_, i) => {
        if (i < 20) return null;
        const w = rets.slice(i - 19, i + 1);
        if (w.some((x) => x == null)) return null;
        const m = (w as number[]).reduce((a, b) => a + b, 0) / 20;
        const varc = (w as number[]).reduce((a, b) => a + (b - m) ** 2, 0) / 20;
        return Math.sqrt(varc) * Math.sqrt(252) * 100;
      });
      const ma = smaSeries(rv, 50);
      return rv.map((x, i) => (x != null && ma[i] ? x / (ma[i] as number) : null));
    },
  },
  {
    key: "kr_safehaven",
    label: "안전자산 선호 (주식 − 채권 20일)",
    valueLabel: "KOSPI 20일 − 국채 20일 수익률차 (%p)",
    higherIsGreedy: true,
    series: (all) => {
      const closes = all.map((x) => x.kospiClose);
      const g10 = all.map((x) => x.gov10y);
      return all.map((_d, i) => {
        if (i < 20) return null;
        const a = closes[i];
        const b = closes[i - 20];
        const y = g10[i];
        const y0 = g10[i - 20];
        if (a == null || b == null || b === 0 || y == null || y0 == null) return null;
        const stk = ((a - b) / b) * 100;
        const bond = -(y - y0) * 8; // 채권 총수익 근사: −Δ수익률 × 듀레이션(≈8)
        return stk - bond;
      });
    },
  },
  {
    key: "kr_credit",
    label: "정크본드 수요 (BBB− − AA− 회사채)",
    valueLabel: "BBB− − AA− 회사채 3년 스프레드 (%p) — 확대 = 공포",
    higherIsGreedy: false,
    series: (all) =>
      all.map((d) => (d.corpBBB != null && d.corpAA != null ? d.corpBBB - d.corpAA : null)),
  },
  {
    key: "kr_putcall",
    label: "풋/콜 옵션",
    valueLabel: "코스피200 옵션 풋/콜 거래량비 — 높을수록 공포",
    higherIsGreedy: false,
    series: (all) => all.map((d) => d.putCall),
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
    const s = c.series(all);
    const raw: Row[] = [];
    all.forEach((d, i) => {
      const v = s[i];
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
