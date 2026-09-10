import "server-only";
import { getAdapter } from "../registry";
import { resolveCorpCode } from "./corpcode";
import { type KrFacts, fetchKrFacts, annualSeries } from "./dart-facts";
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
const IS = ["IS", "CIS"];
const REV = { ids: ["ifrs-full_Revenue", "dart_Revenue"], names: ["매출액", "수익(매출액)", "영업수익"] };
const OPI = { ids: ["dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"], names: ["영업이익"] };
const NI = { ids: ["ifrs-full_ProfitLoss"], names: ["당기순이익", "분기순이익", "반기순이익"] };

/** facts 의 연간 시계열 중 가장 최근 연도 값. */
function latestOf(facts: KrFacts, ids: string[], names: string[], sj: string[]): number | null {
  const s = annualSeries(facts, ids, names, sj);
  const years = [...s.keys()].sort((a, b) => b - a);
  return years.length ? (s.get(years[0]) ?? null) : null;
}

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

  // 레거시 getTtm(자체 한글 계정명 매칭)이 못 잡는 종목은 dart-facts 최근 연간값으로 폴백
  const revenue = ttm?.revenue ?? (facts ? latestOf(facts, REV.ids, REV.names, IS) : null);
  const opIncome = ttm?.opIncome ?? (facts ? latestOf(facts, OPI.ids, OPI.names, IS) : null);
  const netIncome = ttm?.netIncome ?? (facts ? latestOf(facts, NI.ids, NI.names, IS) : null);
  const eps = ttm?.eps ?? null;

  const perTtm =
    price != null && eps != null && eps > 0
      ? price / eps
      : marketCap != null && netIncome != null && netIncome > 0
        ? marketCap / netIncome
        : null;
  const pbr = marketCap != null && equity != null && equity > 0 ? marketCap / equity : null;
  const opMargin = revenue && opIncome != null ? opIncome / revenue : null;
  const netMargin = revenue && netIncome != null ? netIncome / revenue : null;

  return { marketCap, perTtm, pbr, revenueAnnual: revenue, opMargin, netMargin };
}
