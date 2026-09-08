import "server-only";
import YahooFinancePkg from "yahoo-finance2";

/**
 * 미국 52주 베타 자체 계산 — β = Cov(종목 일간수익률, S&P500 일간수익률) / Var(S&P500).
 * 종목·지수 일봉 모두 yahoo-finance2 chart (조정종가). 최근 252거래일 창.
 * Yahoo 제공 베타(defaultKeyStatistics.beta)는 5년 월간이라 성격이 달라 별도 산출.
 */

const YahooFinance = (YahooFinancePkg as { default?: unknown }).default ?? YahooFinancePkg;
type YF = {
  chart: (
    s: string,
    o: Record<string, unknown>,
  ) => Promise<{
    quotes: { date: Date | string; close?: number | null; adjclose?: number | null }[];
  }>;
};
let yf: YF | null = null;
function yfi(): YF {
  if (!yf) {
    const C = YahooFinance as new (o: Record<string, unknown>) => YF;
    yf = new C({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
  }
  return yf;
}

async function closes(sym: string, fromMs: number): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const { quotes } = await yfi().chart(sym, {
      period1: Math.floor(fromMs / 1000),
      interval: "1d",
    });
    for (const q of quotes) {
      const d = (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10);
      const c = q.adjclose ?? q.close;
      if (c != null && Number.isFinite(c) && c > 0) map.set(d, c);
    }
  } catch {
    /* 심볼 실패 */
  }
  return map;
}

export interface Beta52w {
  beta: number;
  prevBeta: number | null;
  change: number | null;
  n: number;
  from: string;
  to: string;
  high52: number | null;
  low52: number | null;
}

function betaOf(s: number[], m: number[]): number | null {
  if (s.length < 30 || s.length !== m.length) return null;
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const sm = mean(s);
  const mm = mean(m);
  let cov = 0;
  let varM = 0;
  for (let i = 0; i < s.length; i++) {
    cov += (s[i] - sm) * (m[i] - mm);
    varM += (m[i] - mm) ** 2;
  }
  return varM === 0 ? null : cov / varM;
}

export async function computeUs52wBeta(
  symbol: string,
  yahooOverride?: string | null,
): Promise<Beta52w | null> {
  const fromMs = Date.now() - 400 * 864e5;

  const [stock, spx] = await Promise.all([
    closes(yahooOverride || symbol, fromMs),
    closes("^GSPC", fromMs),
  ]);
  if (stock.size < 60 || spx.size < 60) return null;

  const dates = [...stock.keys()].filter((d) => spx.has(d)).sort();
  const sr: number[] = [];
  const mr: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const s0 = stock.get(dates[i - 1])!;
    const s1 = stock.get(dates[i])!;
    const m0 = spx.get(dates[i - 1])!;
    const m1 = spx.get(dates[i])!;
    if (s0 > 0 && m0 > 0) {
      sr.push(Math.log(s1 / s0));
      mr.push(Math.log(m1 / m0));
    }
  }
  if (sr.length < 60) return null;
  const take = Math.min(252, sr.length);

  const beta = betaOf(sr.slice(-take), mr.slice(-take));
  if (beta == null) return null;

  let prevBeta: number | null = null;
  if (sr.length >= take + 1) {
    prevBeta = betaOf(sr.slice(-(take + 1), -1), mr.slice(-(take + 1), -1));
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const used = dates.slice(-(take + 1));

  const c52 = dates.slice(-252).map((d) => stock.get(d)!).filter((v) => v > 0);
  const high52 = c52.length ? Math.max(...c52) : null;
  const low52 = c52.length ? Math.min(...c52) : null;

  return {
    beta: r3(beta),
    prevBeta: prevBeta != null ? r3(prevBeta) : null,
    change: prevBeta != null ? r3(beta - prevBeta) : null,
    n: take,
    from: used[0] ?? dates[0],
    to: used[used.length - 1] ?? dates[dates.length - 1],
    high52,
    low52,
  };
}
