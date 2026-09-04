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
  /** 점수 산출용 원시 시계열 (null = 해당일 산출 불가) */
  series: (all: KrFgDailyDoc[]) => (number | null)[];
  /** 원시값이 높을수록 탐욕이면 true */
  higherIsGreedy: boolean;
  /** 0~100 환산 시 비교할 과거 거래일 수 (미지정 시 기본 3년) */
  normWindow?: number;
  /**
   * 역사적 범위 대신 고정 기준으로 환산 [점수100 값, 점수0 값].
   * 시장 구조가 CNN과 달라 절대 수준 비교가 필요할 때 (풋/콜 등).
   */
  fixedRange?: [number, number];
  /**
   * 차트에 점수 시계열 대신 "기준선(dashed) + 오버레이(실선)"를 그릴 때.
   * CNN 모멘텀 차트(S&P + 125일선)와 동일 표현.
   */
  plot?: (all: KrFgDailyDoc[]) => {
    history: { date: string; value: number }[];
    overlay: { label: string; history: { date: string; value: number }[] };
  } | null;
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
    valueLabel: "KOSPI 125일 이동평균",
    higherIsGreedy: true,
    // 125일선은 "거래일(kospiClose 존재)"만 추려 계산한다. 연말 휴장일 등
    // 중간 결측이 smaSeries 특성상 이후 125거래일 MA 를 통째로 null 로
    // 만들어 6개월씩 데이터가 사라지는 문제 방지 (휴장일은 거래일이 아님).
    series: (all) => {
      const pts = all
        .map((d, i) => ({ i, c: d.kospiClose }))
        .filter((p): p is { i: number; c: number } => p.c != null);
      const ma = smaSeries(
        pts.map((p) => p.c),
        125,
      );
      const out: (number | null)[] = new Array(all.length).fill(null);
      pts.forEach((p, k) => {
        const m = ma[k];
        if (m != null) out[p.i] = ((p.c - m) / m) * 100;
      });
      return out;
    },
    plot: (all) => {
      const rows = all.filter((d) => d.kospiClose != null);
      const closes = rows.map((d) => d.kospiClose as number);
      const ma = smaSeries(closes, 125);
      const maRows: { date: string; value: number }[] = [];
      const kospiRows: { date: string; value: number }[] = [];
      rows.forEach((d, k) => {
        if (ma[k] != null) {
          maRows.push({ date: d._id, value: Math.round((ma[k] as number) * 100) / 100 });
          kospiRows.push({ date: d._id, value: Math.round(closes[k] * 100) / 100 });
        }
      });
      return maRows.length ? { history: maRows, overlay: { label: "KOSPI", history: kospiRows } } : null;
    },
  },
  {
    key: "kr_strength",
    label: "주가 강도 (52주 신고가/신저가)",
    valueLabel: "52주 (신고가 − 신저가) / 대상종목 · 5일 평균 (순비율 %)",
    higherIsGreedy: true,
    normWindow: 500, // CNN: 과거 2년(~500영업일)
    series: (all) => {
      // 순개수는 일별 스파이크가 커서 CNN처럼 매끄러운 선이 안 됨
      //  → 대상종목 대비 순비율(%) + 5일 이동평균으로 노이즈 제거
      const net = all.map((d) =>
        d.newHigh52 != null && d.newLow52 != null && d.totalWithHistory
          ? ((d.newHigh52 - d.newLow52) / d.totalWithHistory) * 100
          : null,
      );
      return smaSeries(net, 5);
    },
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
    key: "kr_putcall",
    label: "풋/콜 옵션",
    valueLabel: "코스피200 옵션 풋/콜 거래대금비 5일 이동평균",
    higherIsGreedy: false,
    // CNN 기준선(0.7~0.8=공포 진입, 0.5~0.6 이하=탐욕)에 맞춰 고정 환산:
    // 0.45 → 점수 100(극탐욕), 0.95 → 점수 0(극공포). 우리 역사 스파이크 무관.
    fixedRange: [0.45, 0.95],
    series: (all) => {
      // 거래대금 기준(개인 투기 쏠림 완화) + 5일 이동평균으로 노이즈 제거
      const pc = all.map((d) => d.putCallVal ?? d.putCall);
      return smaSeries(pc, 5);
    },
  },
  {
    key: "kr_vkospi",
    label: "변동성 (VKOSPI)",
    valueLabel: "코스피200 변동성지수 (VKOSPI)",
    higherIsGreedy: false,
    series: (all) => all.map((x) => x.vkospi),
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
    // CNN(정크yield − 투자등급yield)과 동일 구조: 등급간 스프레드 + 역사적 백분위 정규화.
    // 국내 공개 금리로는 BBB− 가 최하단(사실상 정크 프록시), AA− 가 투자등급 기준.
    series: (all) =>
      all.map((d) => (d.corpBBB != null && d.corpAA != null ? d.corpBBB - d.corpAA : null)),
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

/**
 * 시계열을 최근 창의 "역사적 범위"로 0~100 정규화 (invert 옵션).
 * 단순 min-max 는 극단값 1개에 범위가 늘어나 왜곡 → 5~95 백분위로 클립 후 스케일.
 */
function normalize(
  series: Row[],
  invert: boolean,
  window = NORM_WINDOW,
  fixedRange?: [number, number],
): Row[] {
  if (fixedRange) {
    // fixedRange = [점수100 값, 점수0 값]. invert 무시 (부호는 범위 방향으로 반영)
    const [gVal, fVal] = fixedRange;
    return series.map((r) => {
      const s = Math.max(0, Math.min(100, ((fVal - r.value) / (fVal - gVal)) * 100));
      return { date: r.date, value: Math.round(s * 10) / 10 };
    });
  }
  const win = series.slice(-window);
  const vals = win.map((r) => r.value).filter(Number.isFinite).sort((a, b) => a - b);
  if (vals.length < 10) return [];
  const pct = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * p)))];
  const lo = pct(0.02);
  const hi = pct(0.98);
  const range = hi - lo || 1;
  return series.map((r) => {
    let s = ((r.value - lo) / range) * 100;
    s = Math.max(0, Math.min(100, s));
    return { date: r.date, value: Math.round((invert ? 100 - s : s) * 10) / 10 };
  });
}

export async function getKrFearGreed(): Promise<
  (FearGreed & { ready: boolean; componentsReady: number; vkospiAvg: number | null; creditAvg: number | null }) | null
> {
  const all = await getKrFgHistory().catch(() => []);
  if (all.length < 5) return null;

  const mean = (xs: number[]) =>
    xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
  // 세부차트 기준선용 장기 평균
  const vkospiAvg = mean(
    all.map((d) => d.vkospi).filter((v): v is number => v != null && Number.isFinite(v)),
  );
  const creditAvg = mean(
    all
      .map((d) => (d.corpBBB != null && d.corpAA != null ? d.corpBBB - d.corpAA : null))
      .filter((v): v is number => v != null && Number.isFinite(v)),
  );

  const compScored = COMPONENTS.map((c) => {
    const s = c.series(all);
    const raw: Row[] = [];
    all.forEach((d, i) => {
      const v = s[i];
      if (v != null && Number.isFinite(v)) raw.push({ date: d._id, value: Math.round(v * 1000) / 1000 });
    });
    const scored = normalize(raw, !c.higherIsGreedy, c.normWindow ?? NORM_WINDOW, c.fixedRange);
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

  // CNN 홈페이지와 동일: 점수 정수 반올림 후 등급 판정
  const scoreInt = Math.round(latest.value);
  return {
    score: scoreInt,
    rating: ratingEn(scoreInt),
    ratingKo: ratingKo(scoreInt),
    asOf: latest.date,
    prevClose: Math.round(at(1)),
    prev1w: Math.round(at(5)),
    prev1m: Math.round(at(21)),
    prev1y: Math.round(at(252)),
    history: history.slice(-180),
    components: compScored.map(({ c, raw, scored }) => {
      const p = c.plot?.(all) ?? null;
      return {
        key: c.key,
        label: c.label,
        valueLabel: c.valueLabel,
        score: scored.length ? Math.round(scored[scored.length - 1].value * 10) / 10 : null,
        rating: scored.length ? ratingEn(scored[scored.length - 1].value) : null,
        // 세부차트 표시 구간: 미국(CNN) 컴포넌트 차트와 동일하게 최근 180 거래일
        history: (p?.history ?? raw).slice(-180),
        ...(p ? { overlay: { label: p.overlay.label, history: p.overlay.history.slice(-180) } } : {}),
      };
    }),
    source: "K-공포탐욕지수",
    deepLink: "https://data.krx.co.kr",
    ready: componentsReady >= 5,
    componentsReady,
    vkospiAvg,
    creditAvg,
  };
}
