import "server-only";
import YahooFinancePkg from "yahoo-finance2";

/**
 * 주요 지수·원자재 차트 (최근 1년, 일봉) + 기술적 지표.
 * yahoo-finance2 (개인용/비상업 한정 — prd.md §4.3).
 */

const YahooFinance = (YahooFinancePkg as { default?: unknown }).default ?? YahooFinancePkg;

type YF = { chart: (s: string, o: Record<string, unknown>) => Promise<{ quotes: RawBar[] }> };
interface RawBar {
  date: Date | string;
  close?: number | null;
  adjclose?: number | null;
}

let yf: YF | null = null;
function yfi(): YF {
  if (!yf) {
    const C = YahooFinance as new (o: Record<string, unknown>) => YF;
    yf = new C({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
  }
  return yf;
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
}

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

export const CHART_YEARS = [1, 3, 5, 10] as const;
export type ChartYears = (typeof CHART_YEARS)[number];

export async function getIndexChart(key: string, years: ChartYears = 1): Promise<IndexChart | null> {
  const spec = SYMBOLS[key];
  if (!spec) return null;

  // 지표 워밍업(BB20·MACD26+9)용으로 요청 기간 + 3개월 더 받아서 잘라낸다
  const from = new Date();
  from.setMonth(from.getMonth() - (years * 12 + 3));

  let quotes: RawBar[];
  try {
    const res = await yfi().chart(spec.symbol, {
      period1: from.toISOString().slice(0, 10),
      interval: "1d",
    });
    quotes = res.quotes ?? [];
  } catch {
    return null;
  }

  const pts = quotes
    .map((q) => ({
      date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10),
      close: (q.adjclose ?? q.close) ?? NaN,
    }))
    .filter((p) => Number.isFinite(p.close));
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
      bbU: round(bb[i].u),
      bbM: round(bb[i].m),
      bbL: round(bb[i].l),
      macd: round(m, 3),
      signal: round(s, 3),
      hist: m != null && s != null ? round(m - s, 3) : null,
    };
  });

  // 요청 기간(약 252거래일/년)만 반환 — 앞부분은 지표 워밍업용
  return { key, name: spec.name, rows: rows.slice(-(years * 252)) };
}
