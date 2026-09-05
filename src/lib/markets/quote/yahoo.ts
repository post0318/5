/**
 * Yahoo Finance (yahoo-finance2) — L2 시세 폴백 + L4 포워드 컨센서스 (prd.md §4.1)
 *
 * ⚠️ 개인용/비상업 한정. Yahoo ToS상 재배포·상업적 사용 금지.
 *    팀/대외 확장 시 이 모듈 사용 중단 → 딥링크 또는 정식 라이선스 (prd.md §4.3).
 *
 * 서버 전용. next.config 의 serverExternalPackages 에 등록되어 있어야 한다.
 */

import "server-only";
import YahooFinancePkg from "yahoo-finance2";
import { consensusDeepLinks } from "../deeplinks";
import {
  AdapterError,
  MARKET_CURRENCY,
  type ForwardConsensus,
  type MarketId,
  type QuoteBar,
} from "../types";
import { yahooSymbol } from "./symbols";

const YahooFinance = (YahooFinancePkg as { default?: unknown }).default ?? YahooFinancePkg;

type YFInstance = {
  chart: (s: string, o: Record<string, unknown>) => Promise<{ quotes: RawBar[] }>;
  quoteSummary: (s: string, o: Record<string, unknown>) => Promise<QuoteSummaryResult>;
};

interface RawBar {
  date: Date | string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
}

interface QuoteSummaryResult {
  summaryDetail?: {
    forwardPE?: number;
    dividendYield?: number;
    dividendRate?: number;
    trailingAnnualDividendRate?: number;
    beta?: number;
    fiftyTwoWeekHigh?: number;
    fiftyTwoWeekLow?: number;
  };
  defaultKeyStatistics?: { forwardPE?: number; beta?: number; "52WeekChange"?: number };
  financialData?: {
    targetMeanPrice?: number;
    targetHighPrice?: number;
    targetLowPrice?: number;
    numberOfAnalystOpinions?: number;
    recommendationKey?: string;
    recommendationMean?: number;
    currentRatio?: number;
  };
  earningsTrend?: {
    trend?: {
      period?: string;
      endDate?: string | null;
      earningsEstimate?: {
        avg?: number | null;
        low?: number | null;
        high?: number | null;
        numberOfAnalysts?: number | null;
        yearAgoEps?: number | null;
      };
      revenueEstimate?: {
        avg?: number | null;
        low?: number | null;
        high?: number | null;
        numberOfAnalysts?: number | null;
        yearAgoRevenue?: number | null;
      };
      epsTrend?: {
        current?: number | null;
        "7daysAgo"?: number | null;
        "30daysAgo"?: number | null;
        "60daysAgo"?: number | null;
        "90daysAgo"?: number | null;
      };
    }[];
  };
  earningsHistory?: {
    history?: {
      epsActual?: number | null;
      epsEstimate?: number | null;
      epsDifference?: number | null;
      surprisePercent?: number | null;
      quarter?: string | Date | null;
      period?: string | null;
    }[];
  };
}

/** 컨센서스 패널용 상세 추정 데이터 (개인용 · yahoo). */
export interface YahooEstimates {
  currency: string;
  recommendationMean: number | null;
  targetMeanPrice: number | null;
  /** 회계연도(및 분기) 추정: period 는 "0y" | "+1y" | "+2y" | "0q" | "+1q" */
  periods: {
    period: string;
    endDate: string | null;
    epsAvg: number | null;
    epsLow: number | null;
    epsHigh: number | null;
    epsAnalysts: number | null;
    revenueAvg: number | null;
    revenueLow: number | null;
    revenueHigh: number | null;
    /** EPS 추정치 리비전: 현재 / 7일전 / 30일전 / 60일전 / 90일전 */
    epsTrend: {
      current: number | null;
      d7: number | null;
      d30: number | null;
      d60: number | null;
      d90: number | null;
    };
  }[];
  /** 최근 분기 어닝 서프라이즈 (오래된 것 → 최신) */
  surprises: {
    period: string;
    epsEstimate: number | null;
    epsActual: number | null;
    surprisePct: number | null;
  }[];
}

export async function fetchYahooEstimates(
  market: MarketId,
  symbol: string,
  yahooOverride?: string | null,
): Promise<YahooEstimates> {
  const candidates = candidateSymbols(market, symbol, yahooOverride);
  let qs: QuoteSummaryResult | null = null;
  let lastErr: unknown;
  for (const s of candidates) {
    try {
      qs = await yf().quoteSummary(s, {
        modules: ["earningsTrend", "earningsHistory", "financialData"],
      });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!qs) {
    throw new AdapterError(`Yahoo 추정 조회 실패: ${candidates.join(", ")}`, { cause: lastErr });
  }
  const iso = (d: string | Date | null | undefined): string | null => {
    if (!d) return null;
    const dt = typeof d === "string" ? new Date(d) : d;
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
  };
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const trend = qs.earningsTrend?.trend ?? [];
  const periods = trend
    .filter((t) => ["0y", "+1y", "+2y", "0q", "+1q"].includes(t.period ?? ""))
    .map((t) => {
      const e = t.earningsEstimate ?? {};
      const r = t.revenueEstimate ?? {};
      const et = t.epsTrend ?? {};
      return {
        period: t.period as string,
        endDate: iso(t.endDate),
        epsAvg: n(e.avg),
        epsLow: n(e.low),
        epsHigh: n(e.high),
        epsAnalysts: n(e.numberOfAnalysts),
        revenueAvg: n(r.avg),
        revenueLow: n(r.low),
        revenueHigh: n(r.high),
        epsTrend: {
          current: n(et.current),
          d7: n(et["7daysAgo"]),
          d30: n(et["30daysAgo"]),
          d60: n(et["60daysAgo"]),
          d90: n(et["90daysAgo"]),
        },
      };
    });

  const surprises = (qs.earningsHistory?.history ?? [])
    .map((h) => ({
      period: iso(h.quarter) ?? String(h.period ?? ""),
      epsEstimate: n(h.epsEstimate),
      epsActual: n(h.epsActual),
      surprisePct:
        n(h.surprisePercent) != null
          ? (n(h.surprisePercent) as number) * 100
          : n(h.epsEstimate) && n(h.epsActual) != null
            ? (((n(h.epsActual) as number) - (n(h.epsEstimate) as number)) /
                Math.abs(n(h.epsEstimate) as number)) *
              100
            : null,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));

  return {
    currency: MARKET_CURRENCY[market],
    recommendationMean: n(qs.financialData?.recommendationMean),
    targetMeanPrice: n(qs.financialData?.targetMeanPrice),
    periods,
    surprises,
  };
}

let instance: YFInstance | null = null;
function yf(): YFInstance {
  if (!instance) {
    const Ctor = YahooFinance as new (opts: Record<string, unknown>) => YFInstance;
    instance = new Ctor({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
  }
  return instance;
}

function isoDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

/** KR은 KOSPI(.KS)/KOSDAQ(.KQ) 구분이 필요 → override 없으면 둘 다 시도 */
function candidateSymbols(market: MarketId, symbol: string, override?: string | null): string[] {
  if (override) return [override];
  if (market === "kr") {
    const code = symbol.replace(/[^0-9]/g, "").padStart(6, "0").slice(-6);
    return [`${code}.KS`, `${code}.KQ`];
  }
  return [yahooSymbol(market, symbol)];
}

export async function fetchYahooEod(
  market: MarketId,
  symbol: string,
  opts: { from?: string; to?: string; yahooOverride?: string | null } = {},
): Promise<QuoteBar[]> {
  const candidates = candidateSymbols(market, symbol, opts.yahooOverride);
  let lastErr: unknown;
  for (const s of candidates) {
    try {
      const res = await yf().chart(s, {
        period1: opts.from ?? "2019-01-01",
        period2: opts.to ?? isoDate(new Date()),
        interval: "1d",
      });
      const bars = res.quotes
        .filter((q) => q.close != null)
        .map((q) => ({
          date: isoDate(q.date),
          open: q.open ?? null,
          high: q.high ?? null,
          low: q.low ?? null,
          close: q.close ?? null,
          volume: q.volume ?? null,
        }));
      if (bars.length) return bars;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new AdapterError(`Yahoo 시세 조회 실패: ${candidates.join(", ")}`, { cause: lastErr });
}

export async function fetchForwardConsensus(
  market: MarketId,
  symbol: string,
  yahooOverride?: string | null,
): Promise<ForwardConsensus> {
  const candidates = candidateSymbols(market, symbol, yahooOverride);
  let qs: QuoteSummaryResult | null = null;
  let lastErr: unknown;
  for (const s of candidates) {
    try {
      qs = await yf().quoteSummary(s, {
        modules: ["summaryDetail", "defaultKeyStatistics", "financialData", "earningsTrend"],
      });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!qs) {
    throw new AdapterError(`Yahoo 컨센서스 조회 실패: ${candidates.join(", ")}`, { cause: lastErr });
  }

  const fd = qs.financialData ?? {};
  const sd = qs.summaryDetail ?? {};
  const trend = (qs.earningsTrend?.trend ?? []).filter(
    (t) => t.period === "0y" || t.period === "+1y" || t.period === "+2y",
  );

  return {
    symbol,
    market,
    currency: MARKET_CURRENCY[market],
    forwardPer: qs.defaultKeyStatistics?.forwardPE ?? sd.forwardPE ?? null,
    targetMeanPrice: fd.targetMeanPrice ?? null,
    targetHighPrice: fd.targetHighPrice ?? null,
    targetLowPrice: fd.targetLowPrice ?? null,
    numberOfAnalysts: fd.numberOfAnalystOpinions ?? null,
    recommendationKey: fd.recommendationKey ?? null,
    // 부수 요약 지표 (yahoo summaryDetail/financialData). 컨센서스와 무관하지만
    // 같은 quoteSummary 호출로 이미 받아온 값이라 추가 비용 없이 노출.
    fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: sd.fiftyTwoWeekLow ?? null,
    beta: sd.beta ?? qs.defaultKeyStatistics?.beta ?? null,
    currentRatio: fd.currentRatio ?? null,
    dividendPerShare: sd.dividendRate ?? sd.trailingAnnualDividendRate ?? null,
    dividendYield: sd.dividendYield ?? null, // yahoo: 소수(0.021 = 2.1%)
    estimates: trend.map((t) => ({
      period: t.period === "0y" ? "당해년도(FY)" : t.period === "+1y" ? "차년도(FY+1)" : "FY+2",
      epsAvg: t.earningsEstimate?.avg ?? null,
      epsLow: t.earningsEstimate?.low ?? null,
      epsHigh: t.earningsEstimate?.high ?? null,
      revenueAvg: t.revenueEstimate?.avg ?? null,
    })),
    source: "Yahoo Finance (yahoo-finance2) · 개인용",
    deepLinks: consensusDeepLinks(market, symbol),
  };
}
