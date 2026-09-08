import "server-only";
import YahooFinancePkg from "yahoo-finance2";
import type { KrRightEvent } from "../kr/rights-schedule";

/**
 * 미국 권리일정 — 배당(권리락일·지급일·주당배당금) + 분할/병합.
 * yahoo-finance2 chart events(dividends|splits) + quoteSummary calendarEvents.
 * 한국과 동일 기준: 최근 15개월 ~ 향후, 배당·분할·병합만. 수익률은 연환산(분기배당 ×4).
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
  const sym = yahooOverride || symbol;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 15);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const todayIso = new Date().toISOString().slice(0, 10);

  const [chart, qs] = await Promise.all([
    yfi()
      .chart(sym, {
        period1: cutoff,
        period2: new Date(Date.now() + 120 * 864e5),
        interval: "1d",
        events: "div|split",
      })
      .catch(() => null),
    yfi()
      .quoteSummary(sym, { modules: ["calendarEvents", "summaryDetail"] })
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

  const events: KrRightEvent[] = [];

  // 배당 (권리락일 = yahoo dividend event date)
  const exUpcoming = iso(qs?.calendarEvents?.exDividendDate);
  const payUpcoming = iso(qs?.calendarEvents?.dividendDate);
  for (const dv of chart?.events?.dividends ?? []) {
    const ex = iso(dv.date);
    if (!ex || ex < cutoffIso) continue;
    const px = closeOn(ex);
    events.push({
      basDt: ex, // 미국 T+1: 기준일 = 권리락일
      exRightsDate: ex,
      payoutDate: exUpcoming && ex === exUpcoming ? payUpcoming : null,
      reason: ex > todayIso ? "현금배당(예정)" : "현금배당",
      dividendPerShare: dv.amount,
      dividendYield:
        px != null && px > 0
          ? Math.round(((dv.amount * 4) / px) * 10000) / 100 // 연환산 %
          : null,
      filing: null,
      note: null,
    });
  }

  // 향후 배당 (아직 이벤트 목록에 없고 calendarEvents 로만 확인되는 경우)
  if (
    exUpcoming &&
    exUpcoming > todayIso &&
    !events.some((e) => e.exRightsDate === exUpcoming)
  ) {
    const perQ = qs?.summaryDetail?.dividendRate
      ? qs.summaryDetail.dividendRate / 4
      : (chart?.events?.dividends ?? []).at(-1)?.amount ?? null;
    const px = closeOn(todayIso);
    events.push({
      basDt: exUpcoming,
      exRightsDate: exUpcoming,
      payoutDate: payUpcoming,
      reason: "현금배당(예정)",
      dividendPerShare: perQ,
      dividendYield:
        perQ != null && px != null && px > 0
          ? Math.round(((perQ * 4) / px) * 10000) / 100
          : null,
      filing: null,
      note: "지급액은 직전 분기 기준 추정",
    });
  }

  // 분할 / 병합
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
