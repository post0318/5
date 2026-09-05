import "server-only";
import { getAdapter } from "./registry";
import { getEodQuote } from "./quote";
import { fetchForwardConsensus } from "./quote/yahoo";
import { computeTrailingMultiples } from "./multiples";
import { newsDeepLinks } from "./deeplinks";
import {
  AdapterError,
  type CompanyProfile,
  type FinancialStatement,
  type ForwardConsensus,
  type MarketId,
  type TrailingMultiples,
} from "./types";

export interface StockOverview {
  market: MarketId;
  symbol: string;
  configured: boolean;
  configHint: string;
  profile: CompanyProfile | null;
  quote: Awaited<ReturnType<typeof getEodQuote>> | null;
  multiples: TrailingMultiples | null;
  consensus: ForwardConsensus | null;
  deepLinks: {
    consensus: { label: string; url: string }[];
    news: { label: string; url: string }[];
    filings: { label: string; url: string } | null;
  };
  warnings: string[];
}

async function safe<T>(p: Promise<T>, warnings: string[], label: string): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    const msg = err instanceof AdapterError ? err.message : `${label} 조회 실패`;
    warnings.push(msg);
    return null;
  }
}

/**
 * 상한 시간을 넘기면 거부. 개요 화면은 여러 소스를 Promise.all 로 모으는데,
 * 한 소스(주로 yahoo 컨센서스 — 자체 재시도로 느려질 때가 있음)가 지연되면
 * 화면 전체가 그만큼 늦게 뜬다. 느린 소스는 잘라내고 warning 으로만 남긴다.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new AdapterError(`${label} 응답 지연 (${ms}ms 초과)`)), ms),
    ),
  ]);
}

export async function getStockOverview(
  market: MarketId,
  rawSymbol: string,
  yahooOverride?: string | null,
  opts: { skipQuarterly?: boolean; captureTimings?: (t: Record<string, number>) => void } = {},
): Promise<StockOverview> {
  const adapter = getAdapter(market);
  const symbol = adapter.normalizeSymbol(rawSymbol);
  const warnings: string[] = [];
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const timed = <T>(label: string, p: Promise<T>): Promise<T> => {
    const s = Date.now();
    return p.finally(() => {
      timings[label] = Date.now() - s;
    });
  };

  const [profile, quote, annual, quarterly, consensus] = await Promise.all([
    safe(timed("profile", withTimeout(adapter.getCompanyProfile(symbol), 10_000, "회사정보")), warnings, "회사정보"),
    safe(timed("quote", withTimeout(getEodQuote(market, symbol, { yahooOverride }), 12_000, "시세")), warnings, "시세"),
    safe(timed("annual", withTimeout(adapter.getFinancials(symbol, "annual"), 15_000, "연간 재무제표")), warnings, "연간 재무제표"),
    opts.skipQuarterly
      ? Promise.resolve(null)
      : safe(
          timed("quarterly", withTimeout(adapter.getFinancials(symbol, "quarter"), 15_000, "분기 재무제표")),
          warnings,
          "분기 재무제표",
        ),
    safe(
      timed("consensus", withTimeout(fetchForwardConsensus(market, symbol, yahooOverride), 8_000, "포워드 컨센서스")),
      warnings,
      "포워드 컨센서스",
    ),
  ]);
  timings.total = Date.now() - t0;
  if (opts.captureTimings) opts.captureTimings(timings);

  let multiples: TrailingMultiples | null = null;
  if (quote) {
    multiples = computeTrailingMultiples({
      market,
      symbol,
      quote,
      annual: annual as FinancialStatement | null,
      quarterly: quarterly as FinancialStatement | null,
      sharesOutstanding: quote.sharesOutstanding ?? null,
    });
  }

  return {
    market,
    symbol,
    configured: adapter.isConfigured(),
    configHint: adapter.configHint(),
    profile: profile as CompanyProfile | null,
    quote,
    multiples,
    consensus,
    deepLinks: {
      consensus: adapter.consensusDeepLinks(symbol),
      news: newsDeepLinks(market, symbol),
      filings: adapter.filingsDeepLink(symbol),
    },
    warnings: [...new Set(warnings)],
  };
}
