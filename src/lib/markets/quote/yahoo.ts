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
  summaryDetail?: { forwardPE?: number; dividendYield?: number };
  defaultKeyStatistics?: { forwardPE?: number };
  financialData?: {
    targetMeanPrice?: number;
    targetHighPrice?: number;
    targetLowPrice?: number;
    numberOfAnalystOpinions?: number;
    recommendationKey?: string;
  };
  earningsTrend?: {
    trend?: {
      period?: string;
      endDate?: string | null;
      earningsEstimate?: { avg?: number | null; low?: number | null; high?: number | null };
      revenueEstimate?: { avg?: number | null };
    }[];
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
  const trend = (qs.earningsTrend?.trend ?? []).filter(
    (t) => t.period === "0y" || t.period === "+1y" || t.period === "+2y",
  );

  return {
    symbol,
    market,
    currency: MARKET_CURRENCY[market],
    forwardPer: qs.defaultKeyStatistics?.forwardPE ?? qs.summaryDetail?.forwardPE ?? null,
    targetMeanPrice: fd.targetMeanPrice ?? null,
    targetHighPrice: fd.targetHighPrice ?? null,
    targetLowPrice: fd.targetLowPrice ?? null,
    numberOfAnalysts: fd.numberOfAnalystOpinions ?? null,
    recommendationKey: fd.recommendationKey ?? null,
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
