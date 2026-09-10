/**
 * L3 트레일링 멀티플 — 자체 계산 (prd.md §4.1, §9)
 * 라이선스 문제 없음. L1 재무 + L2 시세로 계산.
 */

import type {
  EodQuote,
  FinancialStatement,
  MarketId,
  TrailingMultiples,
  TtmFlows,
} from "./types";
import { MARKET_CURRENCY } from "./types";

const norm = (s: string) => s.replace(/\s/g, "");

/**
 * 재무제표에서 특정 계정의 가장 최근 값. 공백 무시 정확 매칭 → 없으면 loose 정규식.
 * loose 는 배당조정·부문 항목을 피하려 완전한 항목명이 아닌 계정을 우선.
 *
 * 기간(최신순) 을 바깥 루프로, accountIds(우선순위) 를 안쪽 루프로 돈다 — 회사가
 * 도중에 개념 태그를 바꾼 경우(XOM 의 RevenueFromContractWithCustomerExcludingAssessedTax
 * 가 2021년 이후 끊기고 Revenues 로 전환 등) 먼저 나열된 개념이 옛 연도에만 값이
 * 있다고 그 옛 값을 최신 값보다 앞세우는 걸 막는다 — 최신 연도부터 훑으며 그 연도에
 * 값이 있는 첫 우선순위 개념을 쓴다.
 */
function latestValue(
  fs: FinancialStatement,
  accountIds: string[],
  loose?: RegExp,
): number | null {
  const periodLabels = fs.periods.map((p) => p.label);
  const itemByTarget = new Map<string, FinancialStatement["sections"][number]["items"][number]>();
  let looseItem: FinancialStatement["sections"][number]["items"][number] | null = null;
  for (const section of fs.sections) {
    for (const item of section.items) {
      const nm = norm(item.accountId ?? item.accountName);
      for (const id of accountIds) {
        const key = norm(id);
        if (nm === key && !itemByTarget.has(key)) itemByTarget.set(key, item);
      }
      if (loose && looseItem == null && loose.test(nm) && !/[-·]/.test(item.accountName)) {
        looseItem = item;
      }
    }
  }
  for (const label of periodLabels) {
    for (const id of accountIds) {
      const v = itemByTarget.get(norm(id))?.values[label];
      if (v != null) return v;
    }
  }
  if (looseItem) {
    for (const label of periodLabels) {
      const v = looseItem.values[label];
      if (v != null) return v;
    }
  }
  return null;
}

/**
 * 손익/현금흐름 등 "기간 흐름" 계정의 대표값.
 *
 * EDGAR 분기(10-Q) 데이터는 누적(YTD) 값이 섞여 있어 단순 4분기 합산이 과대계상된다.
 * 그래서 최근 "연간" 값을 우선 사용하고, 연간이 없을 때만 분기 최신 단일값으로 대체한다.
 * (정확한 TTM은 분기별 start/end 구간 판별이 필요 — 후속 과제)
 */
function flowValue(
  annual: FinancialStatement | null,
  quarterly: FinancialStatement | null,
  accountIds: string[],
  loose?: RegExp,
): number | null {
  if (annual) {
    const v = latestValue(annual, accountIds, loose);
    if (v != null) return v;
  }
  if (quarterly) return latestValue(quarterly, accountIds);
  return null;
}

export interface MultiplesInput {
  market: MarketId;
  symbol: string;
  quote: EodQuote;
  annual: FinancialStatement | null;
  quarterly: FinancialStatement | null;
  /** 상장주식수 (있으면 시가총액 계산에 사용) */
  sharesOutstanding?: number | null;
  /** TTM(최근 4분기) 플로우 — 트레일링PER 계산용 */
  ttm?: TtmFlows | null;
  /** 감가상각비 + 무형자산상각비 (연간, EV/EBITDA 정확 산출용). 없으면 EV/EBIT 근사. */
  depreciationAmortisation?: number | null;
}

export function computeTrailingMultiples(input: MultiplesInput): TrailingMultiples {
  const { market, symbol, quote, annual, quarterly, sharesOutstanding, ttm } = input;
  // 미국(EDGAR): 최근분기 재무상태표 스냅샷·D&A 가 있으면 우선 사용.
  // 없으면(국내 등) 종전대로 최근 "연간" 재무제표에서 뽑는다.
  const snap = ttm?.snapshot ?? null;
  const da = input.depreciationAmortisation ?? ttm?.daAnnual ?? null;
  const price = quote.last;
  const quotedMarketCap = quote.marketCap ?? null;

  const epsDiluted = flowValue(
    annual,
    quarterly,
    [
      "EarningsPerShareDiluted",
      "EPS (Diluted)",
      "희석주당이익",
      "희석주당순이익",
      "희석주당이익(손실)",
      "기본주당이익",
      "기본주당이익(손실)",
      "기본희석주당이익",
      "주당이익",
      "주당순이익",
      "基本的1株当たり当期利益 (円)",
      "1株当たり当期純利益 (円)",
    ],
    /주당(순)?이익/,
  );
  const netIncome = flowValue(annual, quarterly, [
    "NetIncomeLoss",
    "ProfitLoss",
    "Net Income",
    "Net Income (incl. NCI)",
    "당기순이익",
    "당기순이익(손실)",
    "분기순이익",
    "반기순이익",
    "연결당기순이익",
    "当期利益（親会社の所有者帰属）",
    "当期純利益",
  ]);
  const revenue = flowValue(annual, quarterly, [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "매출액",
    "수익(매출액)",
    "매출",
    "영업수익",
    "売上高",
    "営業収益 (IFRS)",
  ]);
  const equity =
    snap?.equity ??
    latestValue(annual ?? quarterly ?? emptyFs(market, symbol), [
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
      "Stockholders' Equity",
      "Stockholders' Equity (incl. NCI)",
      "자본총계",
      "純資産額",
      "親会社の所有者に帰属する持分",
      "純資産 / 自己資本",
    ]);
  const totalLiabilities =
    snap?.liabilities ??
    latestValue(annual ?? quarterly ?? emptyFs(market, symbol), [
      "Liabilities",
      "Total Liabilities",
      "부채총계",
    ]);
  const cash =
    snap?.cash ??
    latestValue(annual ?? quarterly ?? emptyFs(market, symbol), [
      "CashAndCashEquivalentsAtCarryingValue",
      "Cash & Equivalents",
      "현금및현금성자산",
      "기말현금및현금성자산",
    ]);
  let opIncome = flowValue(annual, quarterly, [
    "OperatingIncomeLoss",
    "Operating Income",
    "영업이익",
    "영업이익(손실)",
    "営業利益",
    "営業利益 (IFRS)",
  ]);
  // 영업이익 태그가 없으면 매출총이익 − 판관비 − 연구개발비로 파생 (IBM 등)
  if (opIncome == null) {
    const gp = flowValue(annual, quarterly, ["GrossProfit", "매출총이익", "売上総利益"]);
    const sgaV = flowValue(annual, quarterly, [
      "SellingGeneralAndAdministrativeExpense",
      "GeneralAndAdministrativeExpense",
    ]);
    const rndV = flowValue(annual, quarterly, ["ResearchAndDevelopmentExpense"]);
    if (gp != null && (sgaV != null || rndV != null))
      opIncome = gp - (sgaV ?? 0) - (rndV ?? 0);
  }
  // 그래도 없으면 세전이익으로 근사 (XOM·AXP 등 영업이익 태그 자체가 없는 회사 —
  // 비영업 손익이 포함될 수 있음. 하이라이트/재무분석/IS 상세와 동일한 최후 폴백).
  if (opIncome == null) {
    opIncome = flowValue(annual, quarterly, [
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
      "Pretax Income",
      "세전이익",
      "세전이익(손실)",
      "법인세비용차감전순이익",
      "税引前当期純利益",
    ]);
  }

  const shares =
    sharesOutstanding ??
    snap?.shares ??
    (netIncome != null && epsDiluted ? netIncome / epsDiluted : null);
  const marketCap =
    quotedMarketCap ?? (price != null && shares != null ? price * shares : null);

  const per = price != null && epsDiluted ? price / epsDiluted : null;
  // TTM EPS 우선 자체 산출값 → 없으면 순이익/주식수, 그것도 없으면 null
  const epsTtm =
    ttm?.eps != null && ttm.eps > 0
      ? ttm.eps
      : ttm?.netIncome != null && shares
        ? ttm.netIncome / shares
        : null;
  const perTtm = price != null && epsTtm ? price / epsTtm : null;
  const bps = equity != null && shares ? equity / shares : null;
  const pbr = price != null && bps ? price / bps : null;
  // PSR·EV/EBITDA: 분자(시가총액·EV)가 현재가 기준이므로 분모도 TTM 으로 맞춘다.
  // 미국(snapshot 존재)은 EDGAR TTM 사용, 그 외(국내 등)는 종전대로 최근 "연간".
  const revenueForPsr = snap && ttm?.revenue != null ? ttm.revenue : revenue;
  const psr =
    marketCap != null && revenueForPsr ? marketCap / revenueForPsr : null;
  const ev =
    marketCap != null
      ? marketCap + (totalLiabilities ?? 0) - (cash ?? 0)
      : null;
  // EBITDA = 영업이익 + 감가상각비 + 무형자산상각비. D&A 없으면 EV/EBIT 근사.
  const ebitdaOpIncome = snap && ttm?.opIncome != null ? ttm.opIncome : opIncome;
  const ebitdaDa = snap && ttm?.daTtm != null ? ttm.daTtm : da;
  const ebitda =
    ebitdaOpIncome != null ? ebitdaOpIncome + (ebitdaDa ?? 0) : null;
  const evEbitda = ev != null && ebitda ? ev / ebitda : null;
  const evEbitdaIsApprox = (snap ? ttm?.daTtm : da) == null;

  return {
    symbol,
    market,
    asOf: quote.lastDate ?? new Date().toISOString().slice(0, 10),
    per: finite(per),
    perTtm: finite(perTtm),
    pbr: finite(pbr),
    psr: finite(psr),
    evEbitda: finite(evEbitda),
    evEbitdaIsApprox,
    eps: finite(epsDiluted),
    bps: finite(bps),
    dividendYield: null,
    marketCap: finite(marketCap),
    currency: MARKET_CURRENCY[market],
    inputs: {
      price: price ?? null,
      epsDiluted: finite(epsDiluted),
      netIncomeAnnual: finite(netIncome),
      revenueAnnual: finite(revenue),
      equity: finite(equity),
      shares: finite(shares),
      opIncomeAnnual: finite(opIncome),
      epsTtm: finite(epsTtm),
      netIncomeTtm: finite(ttm?.netIncome),
      revenueTtm: finite(ttm?.revenue),
    },
  };
}

function finite(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function emptyFs(market: MarketId, symbol: string): FinancialStatement {
  return {
    symbol,
    market,
    periodType: "annual",
    unit: "",
    currency: MARKET_CURRENCY[market],
    consolidation: "unknown",
    periods: [],
    sections: [],
    source: "",
  };
}
