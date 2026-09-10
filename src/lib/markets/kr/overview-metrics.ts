import "server-only";
import { getAdapter } from "../registry";
import { resolveCorpCode } from "./corpcode";
import { fetchKrFacts, annualSeries } from "./dart-facts";
import { fetchKrxEod } from "../quote/krx";

/**
 * 유니버스 통합뷰용 한국 종목 지표 — DART(account_id 기반, dart-facts) + KRX 시세.
 * 기존 서비스 경로(adapter.getFinancials 원본 라벨 + multiples.ts 문자열 매칭)는
 * 계정명 편차(가온전선·현대로템·대한전선 등)로 구멍이 많이 나 dart-facts 기반으로 교체.
 */
export interface KrOverviewMetrics {
  marketCap: number | null;
  perTtm: number | null;
  pbr: number | null;
  revenueAnnual: number | null; // TTM
  opMargin: number | null; // 0~1
  netMargin: number | null; // 0~1
}

const EQUITY = { ids: ["ifrs-full_Equity"], names: ["자본총계"] };

export async function computeKrOverviewMetrics(symbol: string): Promise<KrOverviewMetrics> {
  const empty: KrOverviewMetrics = {
    marketCap: null,
    perTtm: null,
    pbr: null,
    revenueAnnual: null,
    opMargin: null,
    netMargin: null,
  };
  const adapter = getAdapter("kr");
  let corpCode: string;
  try {
    corpCode = resolveCorpCode("", symbol).corpCode;
  } catch {
    return empty;
  }

  const [facts, krx, ttm] = await Promise.all([
    fetchKrFacts(corpCode, "annual").catch(() => null),
    fetchKrxEod(symbol).catch(() => null),
    adapter.getTtm?.(symbol).catch(() => null) ?? Promise.resolve(null),
  ]);

  const price = krx?.bars.at(-1)?.close ?? null;
  const shares = krx?.listedShares ?? null;
  const marketCap = krx?.marketCap ?? (price != null && shares != null ? price * shares : null);

  let equity: number | null = null;
  if (facts) {
    const eq = annualSeries(facts, EQUITY.ids, EQUITY.names, "BS");
    const years = [...eq.keys()].sort((a, b) => b - a);
    equity = years.length ? (eq.get(years[0]) ?? null) : null;
  }

  const revenue = ttm?.revenue ?? null;
  const perTtm =
    price != null && ttm?.eps != null && ttm.eps > 0
      ? price / ttm.eps
      : marketCap != null && ttm?.netIncome != null && ttm.netIncome > 0
        ? marketCap / ttm.netIncome
        : null;
  const pbr = marketCap != null && equity != null && equity > 0 ? marketCap / equity : null;
  const opMargin = revenue && ttm?.opIncome != null ? ttm.opIncome / revenue : null;
  const netMargin = revenue && ttm?.netIncome != null ? ttm.netIncome / revenue : null;

  return { marketCap, perTtm, pbr, revenueAnnual: revenue, opMargin, netMargin };
}
