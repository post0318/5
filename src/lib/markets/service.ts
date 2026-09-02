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

export async function getStockOverview(
  market: MarketId,
  rawSymbol: string,
  yahooOverride?: string | null,
): Promise<StockOverview> {
  const adapter = getAdapter(market);
  const symbol = adapter.normalizeSymbol(rawSymbol);
  const warnings: string[] = [];

  const [profile, quote, annual, quarterly, consensus] = await Promise.all([
    safe(adapter.getCompanyProfile(symbol), warnings, "회사정보"),
    safe(getEodQuote(market, symbol, { yahooOverride }), warnings, "시세"),
    safe(adapter.getFinancials(symbol, "annual"), warnings, "연간 재무제표"),
    safe(adapter.getFinancials(symbol, "quarter"), warnings, "분기 재무제표"),
    safe(fetchForwardConsensus(market, symbol, yahooOverride), warnings, "포워드 컨센서스"),
  ]);

  let multiples: TrailingMultiples | null = null;
  if (quote) {
    multiples = computeTrailingMultiples({
      market,
      symbol,
      quote,
      annual: annual as FinancialStatement | null,
      quarterly: quarterly as FinancialStatement | null,
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
