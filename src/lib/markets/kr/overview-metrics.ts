import "server-only";
import { getAdapter } from "../registry";
import { resolveCorpCode } from "./corpcode";
import { type KrFacts, fetchKrFacts, annualSeries } from "./dart-facts";
import { getEodQuote } from "../quote";
import { krParentEquityByYear } from "./dart-ev";

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
  last: number | null;
  changePct: number | null;
  currency: "KRW" | null;
}

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

export async function computeKrOverviewMetrics(
  symbol: string,
  yahooOverride?: string | null,
): Promise<KrOverviewMetrics> {
  const adapter = getAdapter("kr");
  // corp_code 는 DART(재무제표) 조회에만 필요 — 시세는 corp_code 와 무관하므로
  // DART 상장사 목록에 없는 종목(ETF·우선주·최근 상장/합병 등)이어도 시세는
  // 계속 조회한다(과거엔 여기서 던지면 함수 전체가 empty 로 빠져 시세까지 비었음).
  let corpCode: string | null;
  try {
    corpCode = resolveCorpCode("", symbol).corpCode;
  } catch {
    corpCode = null;
  }

  const [facts, quote, ttm] = await Promise.all([
    corpCode ? fetchKrFacts(corpCode, "annual").catch(() => null) : Promise.resolve(null),
    // KRX 가 실패해도 getEodQuote 내부에서 Stooq → Yahoo 로 자동 폴백된다
    // (fetchKrxEod 를 직접 쓰면 KRX 실패 = 시세 전부 없음).
    getEodQuote("kr", symbol, { yahooOverride }).catch(() => null),
    adapter.getTtm?.(symbol).catch(() => null) ?? Promise.resolve(null),
  ]);

  const price = quote?.last ?? quote?.bars.at(-1)?.close ?? null;
  const shares = quote?.sharesOutstanding ?? null;
  const marketCap = quote?.marketCap ?? (price != null && shares != null ? price * shares : null);

  // PBR 분모 — LTM 기준(getTtm 스냅샷, dart-ev.ts krLtmBalance: 손익 TTM 의 마지막 분기말
  // 지배주주 자본 — 하이라이트·개요와 같은 값, 오너 결정 2026-09-24). 스냅샷이 없을 때만
  // 최근 사업연도말.
  let equity: number | null = ttm?.snapshot ? (ttm.snapshot.equity ?? null) : null;
  if (!ttm?.snapshot && facts) {
    // PBR 분모 = 지배주주 자본(dart-ev.ts 공통 — 하이라이트·재무분석·개요와 같은 값). 예전엔
    // 비지배지분 포함 자본총계를 써서 유니버스 PBR 만 최대 31% 달랐다(LG에너지솔루션, 검증 2026-09-24).
    const eq = krParentEquityByYear(facts);
    const years = [...eq.keys()].sort((a, b) => b - a);
    equity = years.length ? (eq.get(years[0]) ?? null) : null;
  }

  // 레거시 getTtm(자체 한글 계정명 매칭)이 못 잡는 종목은 dart-facts 최근 연간값으로 폴백
  const revenue = ttm?.revenue ?? (facts ? latestOf(facts, REV.ids, REV.names, IS) : null);
  const opIncome = ttm?.opIncome ?? (facts ? latestOf(facts, OPI.ids, OPI.names, IS) : null);
  const netIncome = ttm?.netIncome ?? (facts ? latestOf(facts, NI.ids, NI.names, IS) : null);
  const eps = ttm?.eps ?? null;

  // EPS 가 있으면(적자 포함) 그것만으로 판정 — 적자면 비움. 없을 때만 시총÷순이익
  const perTtm =
    eps != null
      ? price != null && eps > 0
        ? price / eps
        : null
      : marketCap != null && netIncome != null && netIncome > 0
        ? marketCap / netIncome
        : null;
  const pbr = marketCap != null && equity != null && equity > 0 ? marketCap / equity : null;
  const opMargin = revenue && opIncome != null ? opIncome / revenue : null;
  const netMargin = revenue && netIncome != null ? netIncome / revenue : null;

  return {
    marketCap,
    perTtm,
    pbr,
    revenueAnnual: revenue,
    opMargin,
    netMargin,
    last: price,
    changePct: quote?.changePct ?? null,
    currency: quote ? "KRW" : null,
  };
}
