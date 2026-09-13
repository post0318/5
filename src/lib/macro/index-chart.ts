import "server-only";
import { subMonths } from "date-fns";
import { fetchKrIndexDaily } from "./kr/fsc-index";
import { getKrIndexHistory } from "@/lib/db/kr-index";
import { getYahooFinance } from "./yf-client";
import { fetchRecentKrxIndexBars } from "./indices";

/**
 * 주요 지수·원자재 차트 (최근 1년, 일봉) + 기술적 지표.
 * yahoo-finance2 (개인용/비상업 한정 — prd.md §4.3).
 */

interface RawBar {
  date: Date | string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  adjclose?: number | null;
}

const SYMBOLS: Record<string, { symbol: string; name: string }> = {
  KOSPI: { symbol: "^KS11", name: "코스피" },
  KOSDAQ: { symbol: "^KQ11", name: "코스닥" },
  SPX: { symbol: "^GSPC", name: "S&P 500" },
  IXIC: { symbol: "^IXIC", name: "나스닥 종합" },
  DJI: { symbol: "^DJI", name: "다우존스" },
  N225: { symbol: "^N225", name: "닛케이 225" },
  GOLD: { symbol: "GC=F", name: "금 (Gold)" },
  WTI: { symbol: "CL=F", name: "WTI 원유" },
};

export interface IndexChartRow {
  date: string;
  close: number;
  /** 캔들차트용 — 소스에 없으면 null(그 구간은 캔들을 그리지 않는다). */
  open: number | null;
  high: number | null;
  low: number | null;
  /** 볼린저밴드 (20기간, ±2σ) */
  bbU: number | null;
  bbM: number | null;
  bbL: number | null;
  /** MACD (12/26/9) */
  macd: number | null;
  signal: number | null;
  hist: number | null;
}
export interface IndexChart {
  key: string;
  name: string;
  rows: IndexChartRow[];
  /** 실제 사용된 데이터 출처 (표시용) */
  source: string;
}

/** 소스(금융위·DB·Yahoo)에서 받아온 일봉 — 지표 계산 전 공통 형태. */
type Bar = { date: string; close: number; open: number | null; high: number | null; low: number | null };

function ema(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (prev == null) {
      // 시드 = 첫 period 단순평균
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

// 0.0833 ≈ 1/12년(1개월). `as const` 가 리터럴 타입을 유지하도록 분수식(1/12)
// 대신 소수 리터럴로 둔다 — 식으로 쓰면 ChartYears 가 number 로 넓어진다.
export const CHART_YEARS = [0.0833, 0.25, 0.5, 1, 3, 5, 10] as const;
export type ChartYears = (typeof CHART_YEARS)[number];

export async function getIndexChart(key: string, years: ChartYears = 1): Promise<IndexChart | null> {
  const spec = SYMBOLS[key];
  if (!spec) return null;

  // 지표 워밍업(BB20·MACD26+9)용으로 요청 기간 + 3개월 더 받아서 잘라낸다.
  // years*12 가 소수(0.0833*12=0.9996 등)라 setMonth 직접 산술은 월말 근처에서
  // 워밍업 구간이 의도보다 짧아지는 버그가 있었음 — Math.round + date-fns 로 교체.
  const fromIso = subMonths(new Date(), Math.round(years * 12) + 3).toISOString().slice(0, 10);

  // KOSPI·KOSDAQ 은 KRX 데이터 우선: DB 과거분(2015~2020) + 금융위 지수시세(2020~) 병합.
  // 부족하면 Yahoo 폴백.
  const KR_IDX: Record<string, string> = { KOSPI: "코스피", KOSDAQ: "코스닥" };
  const KR_SERVICE: Record<string, "kospi_dd_trd" | "kosdaq_dd_trd"> = {
    KOSPI: "kospi_dd_trd",
    KOSDAQ: "kosdaq_dd_trd",
  };
  let pts: Bar[] = [];
  // 실제로 사용된 출처를 표시용으로 추적 — 기존엔 화면에서 KOSPI/KOSDAQ 도 항상
  // "Yahoo Finance" 로 표기했으나 실제 소스는 금융위 지수시세(data.go.kr)였음
  // (Yahoo 는 30포인트 미만일 때만 쓰이는 폴백, 2026-09 수정)
  let source = "Yahoo Finance · 개인용";
  if (KR_IDX[key]) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const [hist, fsc] = await Promise.all([
      getKrIndexHistory(key as "KOSPI" | "KOSDAQ", fromIso, todayIso),
      fetchKrIndexDaily(KR_IDX[key], fromIso.replace(/-/g, ""), todayIso.replace(/-/g, "")),
    ]);
    const merged = new Map<string, Bar>();
    for (const p of hist) merged.set(p.date, p);
    for (const p of fsc) merged.set(p.date, p); // 겹치면 금융위(최근)가 우선
    pts = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (pts.length >= 30) source = "금융위 지수시세(data.go.kr) · 개인용";

    // 금융위 지수시세(data.go.kr)는 발행이 2~3영업일 늦어(실측 확인, 2026-09)
    // 대시보드 상단 스냅샷 타일(KRX 실시간 지수 API 사용)보다 차트가 항상 며칠
    // 뒤처져 보임. 같은 KRX 실시간 API로 최근 꼬리(pts 마지막 날짜 이후)만
    // 보충해 격차를 줄인다 — 과거 구간(금융위/DB)은 그대로 두고 안 덮어씀.
    try {
      const recentBars = await fetchRecentKrxIndexBars(KR_SERVICE[key], KR_IDX[key], 5);
      const lastDate = pts.at(-1)?.date;
      const tail = recentBars.filter((b) => !lastDate || b.date > lastDate);
      if (tail.length) {
        pts = [
          ...pts,
          ...tail.map((b) => ({ date: b.date, close: b.close, open: b.open, high: b.high, low: b.low })),
        ];
        if (pts.length >= 30) source = "금융위 지수시세(data.go.kr) + KRX 실시간(최근일 보충) · 개인용";
      }
    } catch {
      // 실시간 보충 실패는 무시 — 금융위/DB 소스만으로 계속 진행
    }
  }

  // KR 소스의 실제 커버리지가 요청 시작일(fromIso)에 못 미치면(예: 10년 요청인데
  // DB 과거분이 최근 2~3년치뿐) — 예전엔 pts.length>=30 이면 "충분"으로 보고
  // 폴백을 건너뛰어 잘린 차트를 그대로 보여줬음. 45일 여유를 두고 판단
  // (2026-09 수정).
  const earliestIso = pts[0]?.date;
  const coverageGap = pts.length < 30 || !earliestIso || earliestIso > fromIso;
  if (coverageGap) {
    let quotes: RawBar[] = [];
    try {
      const res = await getYahooFinance().chart(spec.symbol, { period1: fromIso, interval: "1d" });
      quotes = res.quotes ?? [];
    } catch {
      if (pts.length < 30) return null; // KR 데이터도 없고 Yahoo 도 실패
    }
    // 종가는 기존대로 adjclose 우선, 시·고·저는 원본. 지수·선물은 배당·액면분할
    // 보정이 없어 adjclose 와 close 가 같으므로 캔들 몸통이 어긋나지 않는다.
    const yahooPts = quotes
      .map((q) => ({
        date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10),
        close: (q.adjclose ?? q.close) ?? NaN,
        open: q.open ?? null,
        high: q.high ?? null,
        low: q.low ?? null,
      }))
      .filter((p) => Number.isFinite(p.close));

    if (pts.length < 30) {
      pts = yahooPts;
      if (pts.length) source = "Yahoo Finance · 개인용";
    } else if (yahooPts.length) {
      // KR 데이터가 있는 구간은 그대로 유지, 그보다 이전 공백만 Yahoo 로 보충
      const merged2 = new Map<string, Bar>();
      for (const p of yahooPts) merged2.set(p.date, p);
      for (const p of pts) merged2.set(p.date, p); // 겹치면 KR 소스가 우선
      pts = [...merged2.values()].sort((a, b) => a.date.localeCompare(b.date));
      source = "금융위 지수시세(data.go.kr) + Yahoo Finance(과거분 보충) · 개인용";
    }
  }
  if (pts.length < 30) return null;

  const closes = pts.map((p) => p.close);

  // 볼린저밴드 20
  const BB = 20;
  const bb = closes.map((_, i) => {
    if (i < BB - 1) return { u: null, m: null, l: null };
    const win = closes.slice(i - BB + 1, i + 1);
    const mean = win.reduce((a, b) => a + b, 0) / BB;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / BB);
    return { u: mean + 2 * sd, m: mean, l: mean - 2 * sd };
  });

  // MACD 12/26/9
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macdLine = closes.map((_, i) =>
    e12[i] != null && e26[i] != null ? (e12[i] as number) - (e26[i] as number) : null,
  );
  const macdVals = macdLine.map((v) => v ?? 0);
  const firstMacd = macdLine.findIndex((v) => v != null);
  const sigRaw = ema(macdVals, 9);
  const signal = sigRaw.map((v, i) => (i >= firstMacd + 8 && v != null ? v : null));

  const round = (n: number | null, d = 2) =>
    n == null ? null : Math.round(n * 10 ** d) / 10 ** d;

  const rows: IndexChartRow[] = pts.map((p, i) => {
    const m = macdLine[i];
    const s = signal[i];
    return {
      date: p.date,
      close: round(p.close) as number,
      open: round(p.open),
      high: round(p.high),
      low: round(p.low),
      bbU: round(bb[i].u),
      bbM: round(bb[i].m),
      bbL: round(bb[i].l),
      macd: round(m, 3),
      signal: round(s, 3),
      hist: m != null && s != null ? round(m - s, 3) : null,
    };
  });

  // 요청 기간(약 252거래일/년)만 반환 — 앞부분은 지표 워밍업용
  return { key, name: spec.name, rows: rows.slice(-Math.round(years * 252)), source };
}
