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
  /** 조회 실패·대체 사유(감사 2차 ⑥ — 예전엔 TTM 실패를 삼키고 연간 값으로 PER·PBR 을 계산해 캐시했다). 유니버스 행 warnings 로 */
  warnings: string[];
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

  // 조회 실패는 경고로 남기고 그 값에 기대는 칸은 비운다(감사 2차 ⑥) — 경고 문구에 "조회 실패"가 들어가 keepLastGood 이 직전 정상 스냅샷을 유지한다
  const warnings: string[] = [];
  const warnOf = (what: string) => (e: unknown) => {
    warnings.push(`${what} 조회 실패 — ${e instanceof Error ? e.message : String(e)}`);
    return null;
  };
  const [facts, quote, ttm] = await Promise.all([
    corpCode ? fetchKrFacts(corpCode, "annual").catch(warnOf("연간 재무제표")) : Promise.resolve(null),
    // KRX 가 실패해도 getEodQuote 내부에서 Stooq → Yahoo 로 폴백된다(사유는 quote.warnings)
    getEodQuote("kr", symbol, { yahooOverride }).catch(warnOf("시세")),
    adapter.getTtm?.(symbol).catch(warnOf("손익 TTM")) ?? Promise.resolve(null),
  ]);
  for (const w of quote?.warnings ?? []) warnings.push(`시세: ${w}`);
  const ttmFailed = adapter.getTtm != null && ttm == null;

  const price = quote?.last ?? quote?.bars.at(-1)?.close ?? null;
  const shares = quote?.sharesOutstanding ?? null;
  const marketCap = quote?.marketCap ?? (price != null && shares != null ? price * shares : null);

  // PBR 분모 — LTM 기준(getTtm 스냅샷, dart-ev.ts krLtmBalance: 손익 TTM 의 마지막 분기말
  // 지배주주 자본 — 하이라이트·개요와 같은 값, 오너 결정 2026-09-24). 스냅샷이 없을 때만
  // 최근 사업연도말.
  let equity: number | null = ttm?.snapshot ? (ttm.snapshot.equity ?? null) : null;
  if (!ttm?.snapshot && facts && !ttmFailed) {
    // PBR 분모 = 지배주주 자본(dart-ev.ts 공통 — 하이라이트·재무분석·개요와 같은 값). 예전엔
    // 비지배지분 포함 자본총계를 써서 유니버스 PBR 만 최대 31% 달랐다(LG에너지솔루션, 검증 2026-09-24).
    const eq = krParentEquityByYear(facts);
    const years = [...eq.keys()].sort((a, b) => b - a);
    equity = years.length ? (eq.get(years[0]) ?? null) : null;
    if (equity != null) warnings.push(`PBR 분모: LTM 재무상태표 없음 — FY${years[0]} 지배주주 자본`);
  }

  // TTM 이 성공했는데 항목이 비면 dart-facts 최근 연간값으로(대체 사실을 경고로). TTM 조회 자체가 실패하면 연간값으로 계산하지 않는다(칸 비움)
  const fb = (v: number | null | undefined, ids: string[], names: string[], label: string): number | null => {
    if (v != null) return v;
    if (ttmFailed || !facts) return null;
    const a = latestOf(facts, ids, names, IS);
    if (a != null) warnings.push(`${label}: TTM 없음 — 최근 사업연도 값`);
    return a;
  };
  const revenue = fb(ttm?.revenue, REV.ids, REV.names, "매출(LTM)");
  const opIncome = fb(ttm?.opIncome, OPI.ids, OPI.names, "영업이익(LTM)");
  const netIncome = fb(ttm?.netIncome, NI.ids, NI.names, "순이익(LTM)");
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
    warnings,
  };
}
