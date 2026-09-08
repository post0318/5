import "server-only";
import YahooFinancePkg from "yahoo-finance2";
import type { KrRightEvent } from "../kr/rights-schedule";
import { fetchPolygonDividends } from "./polygon-dividends";

/**
 * 미국 권리일정 — 배당(선언·권리락·기준·지급일) + 분할/병합.
 * 배당: Polygon.io(현 Massive) 4개 날짜 전부 → 미설정 시 yahoo 배당 이벤트(권리락일만)로 폴백.
 * 분할/병합·주가: yahoo-finance2 chart.
 * 한국과 동일 기준: 최근 15개월 ~ 향후, 배당·분할·병합만. 수익률은 연 지급횟수로 연환산.
 */

const YahooFinance = (YahooFinancePkg as { default?: unknown }).default ?? YahooFinancePkg;
type YF = {
  chart: (
    s: string,
    o: Record<string, unknown>,
  ) => Promise<{
    quotes: { date: Date | string; close?: number | null }[];
    events?: {
      dividends?: { amount: number; date: Date | string }[];
      splits?: {
        date: Date | string;
        numerator?: number;
        denominator?: number;
        splitRatio?: string;
      }[];
    };
  }>;
  quoteSummary: (s: string, o: Record<string, unknown>) => Promise<{
    calendarEvents?: { exDividendDate?: string | Date | null; dividendDate?: string | Date | null };
    summaryDetail?: { dividendRate?: number };
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

const iso = (d: string | Date | null | undefined): string | null => {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
};

export async function fetchUsRightsSchedule(
  symbol: string,
  yahooOverride?: string | null,
): Promise<KrRightEvent[]> {
  const ySym = yahooOverride || symbol;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 15);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const todayIso = new Date().toISOString().slice(0, 10);

  const [polyDivs, chart, qs] = await Promise.all([
    fetchPolygonDividends(symbol).catch(() => []),
    yfi()
      .chart(ySym, {
        period1: cutoff,
        period2: new Date(Date.now() + 120 * 864e5),
        interval: "1d",
        events: "div|split",
      })
      .catch(() => null),
    yfi()
      .quoteSummary(ySym, { modules: ["calendarEvents", "summaryDetail"] })
      .catch(() => null),
  ]);

  const closes: { date: string; close: number }[] = (chart?.quotes ?? [])
    .map((q) => ({ date: iso(q.date) ?? "", close: q.close ?? NaN }))
    .filter((q) => q.date && Number.isFinite(q.close));
  const closeOn = (d: string): number | null => {
    let best: number | null = null;
    for (const q of closes) if (q.date <= d) best = q.close;
    return best;
  };
  const yieldPct = (amount: number, freq: number | null, onDate: string): number | null => {
    const px = closeOn(onDate) ?? closeOn(todayIso);
    if (px == null || px <= 0) return null;
    const annual = amount * (freq && freq > 0 ? freq : 4);
    return Math.round((annual / px) * 10000) / 100;
  };

  const events: KrRightEvent[] = [];

  if (polyDivs.length > 0) {
    // Polygon: 4개 날짜 전부
    for (const d of polyDivs) {
      if (d.exDate < cutoffIso) continue;
      const upcoming = d.exDate > todayIso;
      events.push({
        basDt: d.recordDate ?? d.exDate,
        exRightsDate: d.exDate,
        payoutDate: d.payDate,
        reason: upcoming ? "현금배당(예정)" : "현금배당",
        dividendPerShare: d.amount,
        dividendYield: yieldPct(d.amount, d.frequency, d.exDate),
        filing: null,
        note: d.declarationDate ? `선언 ${d.declarationDate}` : null,
      });
    }
  } else {
    // 폴백: yahoo 배당 이벤트 (권리락일 + 금액만)
    const exUpcoming = iso(qs?.calendarEvents?.exDividendDate);
    const payUpcoming = iso(qs?.calendarEvents?.dividendDate);
    for (const dv of chart?.events?.dividends ?? []) {
      const ex = iso(dv.date);
      if (!ex || ex < cutoffIso) continue;
      events.push({
        basDt: ex,
        exRightsDate: ex,
        payoutDate: exUpcoming && ex === exUpcoming ? payUpcoming : null,
        reason: ex > todayIso ? "현금배당(예정)" : "현금배당",
        dividendPerShare: dv.amount,
        dividendYield: yieldPct(dv.amount, 4, ex),
        filing: null,
        note: null,
      });
    }
    if (exUpcoming && exUpcoming > todayIso && !events.some((e) => e.exRightsDate === exUpcoming)) {
      const perQ = qs?.summaryDetail?.dividendRate
        ? qs.summaryDetail.dividendRate / 4
        : (chart?.events?.dividends ?? []).at(-1)?.amount ?? null;
      events.push({
        basDt: exUpcoming,
        exRightsDate: exUpcoming,
        payoutDate: payUpcoming,
        reason: "현금배당(예정)",
        dividendPerShare: perQ,
        dividendYield: perQ != null ? yieldPct(perQ, 4, todayIso) : null,
        filing: null,
        note: "지급액은 직전 분기 기준 추정",
      });
    }
  }

  // 분할 / 병합 (yahoo)
  for (const sp of chart?.events?.splits ?? []) {
    const ex = iso(sp.date);
    if (!ex || ex < cutoffIso) continue;
    const num = sp.numerator ?? 0;
    const den = sp.denominator ?? 0;
    const ratio = sp.splitRatio || (num && den ? `${num}:${den}` : "");
    events.push({
      basDt: ex,
      exRightsDate: ex,
      payoutDate: null,
      reason: num >= den ? "액면분할" : "주식병합",
      dividendPerShare: null,
      dividendYield: null,
      filing: null,
      note: ratio ? `비율 ${ratio}` : null,
    });
  }

  return events.sort((a, b) => b.basDt.localeCompare(a.basDt));
}
