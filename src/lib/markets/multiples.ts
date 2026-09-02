/**
 * L3 트레일링 멀티플 — 자체 계산 (prd.md §4.1, §9)
 * 라이선스 문제 없음. L1 재무 + L2 시세로 계산.
 */

import type {
  EodQuote,
  FinancialStatement,
  MarketId,
  TrailingMultiples,
} from "./types";
import { MARKET_CURRENCY } from "./types";

const norm = (s: string) => s.replace(/\s/g, "");

/** 재무제표에서 특정 계정의 가장 최근 값을 찾는다. (공백 무시 매칭) */
function latestValue(fs: FinancialStatement, accountIds: string[]): number | null {
  const targets = new Set(accountIds.map(norm));
  const periodLabels = fs.periods.map((p) => p.label);
  for (const section of fs.sections) {
    for (const item of section.items) {
      const key = norm(item.accountId ?? item.accountName);
      if (!targets.has(key)) continue;
      for (const label of periodLabels) {
        const v = item.values[label];
        if (v != null) return v;
      }
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
): number | null {
  if (annual) {
    const v = latestValue(annual, accountIds);
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
}

export function computeTrailingMultiples(input: MultiplesInput): TrailingMultiples {
  const { market, symbol, quote, annual, quarterly, sharesOutstanding } = input;
  const price = quote.last;

  const epsDiluted = flowValue(annual, quarterly, [
    "EarningsPerShareDiluted",
    "EPS (Diluted)",
    "희석주당이익",
    "희석주당순이익",
    "주당이익",
    "기본주당이익",
  ]);
  const netIncome = flowValue(annual, quarterly, [
    "NetIncomeLoss",
    "Net Income",
    "당기순이익",
    "당기순이익(손실)",
    "분기순이익",
    "반기순이익",
    "연결당기순이익",
  ]);
  const revenue = flowValue(annual, quarterly, [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "매출액",
    "수익(매출액)",
    "매출",
    "영업수익",
  ]);
  const equity = latestValue(annual ?? quarterly ?? emptyFs(market, symbol), [
    "StockholdersEquity",
    "Stockholders' Equity",
    "자본총계",
  ]);
  const totalLiabilities = latestValue(annual ?? quarterly ?? emptyFs(market, symbol), [
    "Liabilities",
    "Total Liabilities",
    "부채총계",
  ]);
  const cash = latestValue(annual ?? quarterly ?? emptyFs(market, symbol), [
    "CashAndCashEquivalentsAtCarryingValue",
    "Cash & Equivalents",
    "현금및현금성자산",
    "기말현금및현금성자산",
  ]);
  const opIncome = flowValue(annual, quarterly, [
    "OperatingIncomeLoss",
    "Operating Income",
    "영업이익",
    "영업이익(손실)",
  ]);

  const shares =
    sharesOutstanding ??
    (netIncome != null && epsDiluted ? netIncome / epsDiluted : null);
  const marketCap = price != null && shares != null ? price * shares : null;

  const per = price != null && epsDiluted ? price / epsDiluted : null;
  const bps = equity != null && shares ? equity / shares : null;
  const pbr = price != null && bps ? price / bps : null;
  const psr =
    marketCap != null && revenue ? marketCap / revenue : null;
  const ev =
    marketCap != null
      ? marketCap + (totalLiabilities ?? 0) - (cash ?? 0)
      : null;
  // EBITDA 근사: 영업이익 (감가상각 별도 데이터 없을 때)
  const evEbitda = ev != null && opIncome ? ev / opIncome : null;

  return {
    symbol,
    market,
    asOf: quote.lastDate ?? new Date().toISOString().slice(0, 10),
    per: finite(per),
    pbr: finite(pbr),
    psr: finite(psr),
    evEbitda: finite(evEbitda),
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
