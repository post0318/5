import "server-only";
import { getAdapter } from "./registry";
import { getEodQuote } from "./quote";
import { fetchForwardConsensus } from "./quote/yahoo";
import { computeTrailingMultiples } from "./multiples";
import { opUnitsFrom } from "./op-units";
import { newsDeepLinks } from "./deeplinks";
import { isHighDividendKr } from "./kr/high-dividend";
import { isStorableTtm, readTtmSnapAny, writeTtmSnap } from "@/lib/db/ttm-snap";
import {
  AdapterError,
  type CompanyProfile,
  type FinancialStatement,
  type ForwardConsensus,
  type MarketId,
  type TrailingMultiples,
  type TtmFlows,
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
  ttm: TtmFlows | null;
  /** KRX 고배당기업 명단 대상 여부 (한국만) */
  highDividend: boolean;
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
  opts: {
    skipQuarterly?: boolean;
    /**
     * 재무제표(연간·분기)를 아예 조회하지 않는다 → multiples = null.
     * OpenDART 전체 재무제표 호출이 6~15초로 개요 화면의 유일한 병목이라,
     * 인터랙티브 화면에서는 이걸 건너뛰고 클라이언트가 "재무제표" 탭 데이터로
     * 멀티플을 직접 계산한다(그 요청은 어차피 병렬로 나가고 있음).
     */
    skipFinancials?: boolean;
    /**
     * 시세(getEodQuote)를 아예 호출하지 않는다 → quote = null, multiples = null.
     * 호출자가 이미 시세를 따로 확보한 경우(예: 한국 유니버스 개요는
     * computeKrOverviewMetrics 가 별도로 시세를 받는다) 중복 호출을 피한다.
     */
    skipQuote?: boolean;
    /**
     * 연간 재무제표 표(getFinancials annual)만 건너뛴다 — TTM 은 그대로. 미국 멀티플은 TTM 스냅샷(fyEps 포함)만 쓰므로 통합 뷰
     * 갱신에선 표가 필요 없는데, 콜드 상태에서 15초 제한에 걸려 값은 다 있는데 "연간 재무제표 응답 지연" 경고만 남았다(2026-10-02)
     */
    skipAnnualStatement?: boolean;
  } = {},
): Promise<StockOverview> {
  const adapter = getAdapter(market);
  const symbol = adapter.normalizeSymbol(rawSymbol);
  const warnings: string[] = [];

  const wantAnnual = !opts.skipFinancials;
  const wantQuarterly = !opts.skipFinancials && !opts.skipQuarterly;
  const [profile, quote, annualFetched, quarterly, consensus, ttm] = await Promise.all([
    safe(withTimeout(adapter.getCompanyProfile(symbol), 10_000, "회사정보"), warnings, "회사정보"),
    opts.skipQuote
      ? Promise.resolve(null)
      : safe(withTimeout(getEodQuote(market, symbol, { yahooOverride }), 12_000, "시세"), warnings, "시세"),
    wantAnnual && !opts.skipAnnualStatement
      ? safe(withTimeout(adapter.getFinancials(symbol, "annual"), 15_000, "연간 재무제표"), warnings, "연간 재무제표")
      : Promise.resolve(null),
    wantQuarterly
      ? safe(
          withTimeout(adapter.getFinancials(symbol, "quarter"), 15_000, "분기 재무제표"),
          warnings,
          "분기 재무제표",
        )
      : Promise.resolve(null),
    safe(
      withTimeout(fetchForwardConsensus(market, symbol, yahooOverride), 8_000, "포워드 컨센서스"),
      warnings,
      "포워드 컨센서스",
    ),
    wantAnnual && adapter.getTtm
      ? (async () => {
          // 미국은 TTM 저장본(ttm_snap — TTM 라우트·ttm-build 가 채움)을 먼저 — 배포 직후 콜드 상태에서 통합 뷰 갱신이 47종목 전부
          // 15초 제한에 걸려 시가총액·매출이 비었다(2026-10-02). 저장본이 없을 때만 계산하고, 완전한 결과면 저장
          if (market === "us") {
            const hit = await readTtmSnapAny(market, symbol).catch(() => null);
            if (hit) return hit.ttm;
          }
          const t = await safe(withTimeout(adapter.getTtm!(symbol), 15_000, "TTM 재무"), warnings, "TTM 재무");
          if (market === "us" && t && isStorableTtm(t as TtmFlows)) await writeTtmSnap(market, symbol, t as TtmFlows).catch(() => {});
          return t;
        })()
      : Promise.resolve(null),
  ]);

  // 연간 표를 건너뛰었어도 TTM 에 사업연도 EPS 가 없는 경로(DART 연결 ADR — 표의 EPS 가 DART EPS 의 USD·ADR 환산)는 PER 에 표가 필요
  const annual =
    annualFetched ??
    (wantAnnual && opts.skipAnnualStatement && ttm && (ttm as TtmFlows).fyEps === undefined
      ? await safe(withTimeout(adapter.getFinancials(symbol, "annual"), 15_000, "연간 재무제표"), warnings, "연간 재무제표")
      : null);

  let multiples: TrailingMultiples | null = null;
  // 미국은 TTM 스냅샷(getTtm)으로만 계산한다 — 재무를 건너뛴 호출(개요 화면 첫 응답)은 TTM 이 없으므로 계산하지 않는다
  // (화면이 TTM 도착 후 같은 함수로 계산 — stock-analysis.tsx). Yahoo 주식수·시가총액으로 미리 채우지 않는다(그림자 채우기 금지)
  for (const w of quote?.warnings ?? []) warnings.push(`시세: ${w}`);
  if (quote && !(market === "us" && !wantAnnual)) {
    // 듀얼클래스(V 등)는 EDGAR·Yahoo 시세에 undimensioned 주식수·시총이 없다 →
    // Yahoo 컨센서스(quoteSummary)의 값으로 폴백 — 미국 외 시장만(미국은 edgar-shares 공통 주식수만)
    const cShares = (consensus as { sharesOutstanding?: number | null } | null)?.sharesOutstanding ?? null;
    const cMktCap = (consensus as { marketCap?: number | null } | null)?.marketCap ?? null;
    const quoteForMultiples =
      market !== "us" &&
      ((quote.sharesOutstanding == null && cShares != null) ||
        (quote.marketCap == null && cMktCap != null))
        ? {
            ...quote,
            sharesOutstanding: quote.sharesOutstanding ?? cShares,
            marketCap: quote.marketCap ?? cMktCap,
          }
        : quote;
    multiples = computeTrailingMultiples({
      market,
      symbol,
      quote: quoteForMultiples,
      annual: annual as FinancialStatement | null,
      quarterly: quarterly as FinancialStatement | null,
      sharesOutstanding: quoteForMultiples.sharesOutstanding ?? null,
      ttm: ttm as TtmFlows | null,
      opUnits: (() => {
        const t = ttm as TtmFlows | null;
        const c = consensus as { sharesOutstanding?: number | null; impliedSharesOutstanding?: number | null } | null;
        return opUnitsFrom(Boolean(t?.snapshot?.isReit), c?.sharesOutstanding, c?.impliedSharesOutstanding);
      })(),
    });
  }

  // 미국 TTM 조회 실패 사유를 경고에도(개요 멀티플은 reasons 로 칸마다)
  if (market === "us" && wantAnnual && (ttm as TtmFlows | null)?.error) warnings.push((ttm as TtmFlows).error!);

  return {
    market,
    symbol,
    configured: adapter.isConfigured(),
    configHint: adapter.configHint(),
    profile: profile as CompanyProfile | null,
    quote,
    multiples,
    consensus,
    ttm: ttm as TtmFlows | null,
    highDividend: market === "kr" && isHighDividendKr(symbol),
    deepLinks: {
      consensus: adapter.consensusDeepLinks(symbol),
      news: newsDeepLinks(market, symbol),
      filings: adapter.filingsDeepLink(symbol),
    },
    warnings: [...new Set(warnings)],
  };
}
