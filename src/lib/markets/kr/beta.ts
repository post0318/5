import "server-only";
import YahooFinancePkg from "yahoo-finance2";

/**
 * 52주 베타 자체 계산 — β = Cov(종목 일간수익률, KOSPI 일간수익률) / Var(KOSPI).
 * yahoo-finance2 일봉 (개인용/비상업 한정 — prd.md §4.3).
 * Yahoo 제공 베타(5년 월간)는 국내 종목에서 누락·부정확이 잦아 대체.
 */

const YahooFinance = (YahooFinancePkg as { default?: unknown }).default ?? YahooFinancePkg;
type YF = {
  chart: (
    s: string,
    o: Record<string, unknown>,
  ) => Promise<{ quotes: { date: Date | string; close?: number | null }[] }>;
};
let yf: YF | null = null;
function yfi(): YF {
  if (!yf) {
    const C = YahooFinance as new (o: Record<string, unknown>) => YF;
    yf = new C({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
  }
  return yf;
}

async function dailyCloses(sym: string, fromMs: number): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const { quotes } = await yfi().chart(sym, {
      period1: Math.floor(fromMs / 1000),
      interval: "1d",
    });
    for (const q of quotes) {
      const d = (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10);
      if (q.close != null && Number.isFinite(q.close)) map.set(d, q.close);
    }
  } catch {
    /* 심볼 실패 */
  }
  return map;
}

export interface Kr52wBeta {
  beta: number;
  /** 직전 거래일까지의 베타 (같은 창 길이, 하루 전) */
  prevBeta: number | null;
  /** beta − prevBeta */
  change: number | null;
  /** 표본 일수 */
  n: number;
  from: string;
  to: string;
}

/** 두 수익률 배열에서 β = Cov/Var */
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

export async function computeKr52wBeta(
  code: string,
  yahooOverride?: string | null,
): Promise<Kr52wBeta | null> {
  const digits = code.replace(/\D/g, "").padStart(6, "0");
  const from = Date.now() - 400 * 864e5; // 여유롭게 400일 받아 최근 252거래일 사용

  // 종목: override → .KS → .KQ
  const candidates = [yahooOverride, `${digits}.KS`, `${digits}.KQ`].filter(Boolean) as string[];
  let stock = new Map<string, number>();
  for (const c of candidates) {
    stock = await dailyCloses(c, from);
    if (stock.size > 60) break;
  }
  if (stock.size < 60) return null;

  const kospi = await dailyCloses("^KS11", from);
  if (kospi.size < 60) return null;

  // 공통 날짜 정렬 → 일간 로그수익률
  const dates = [...stock.keys()].filter((d) => kospi.has(d)).sort();
  const sr: number[] = [];
  const mr: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    const s0 = stock.get(dates[i - 1])!;
    const s1 = stock.get(dates[i])!;
    const m0 = kospi.get(dates[i - 1])!;
    const m1 = kospi.get(dates[i])!;
    if (s0 > 0 && m0 > 0) {
      sr.push(Math.log(s1 / s0));
      mr.push(Math.log(m1 / m0));
    }
  }
  if (sr.length < 60) return null;
  const take = Math.min(252, sr.length);

  // 오늘 창 (마지막 take개) vs 전일 창 (하루 전에 끝나는 take개)
  const s = sr.slice(-take);
  const m = mr.slice(-take);
  const beta = betaOf(s, m);
  if (beta == null) return null;

  let prevBeta: number | null = null;
  if (sr.length >= take + 1) {
    prevBeta = betaOf(sr.slice(-(take + 1), -1), mr.slice(-(take + 1), -1));
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const used = dates.slice(-(take + 1));
  return {
    beta: r3(beta),
    prevBeta: prevBeta != null ? r3(prevBeta) : null,
    change: prevBeta != null ? r3(beta - prevBeta) : null,
    n: take,
    from: used[0] ?? dates[0],
    to: used[used.length - 1] ?? dates[dates.length - 1],
  };
}
